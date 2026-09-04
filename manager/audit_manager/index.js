// manager/audit_manager/index.js — AuditManager (docs/DESIGN.md §14, §11.2 audit.purge).
// Audit trail append-only di audit.db (skema final: lib/schema.js — trigger
// no_delete/no_update). Purge = two-phase confirm (aturan repo #4):
//   purgeRequest()  → token sekali-pakai (hash disimpan di meta, TTL 10 menit)
//   purgeExecute()  → verifikasi token+expiry+reason → DELETE dalam tx sambil
//                     menurunkan trigger no_delete sementara, lalu INSERT event
//                     AUDIT_PURGE (metadata range + jumlah, tanpa isi row).
// Field `ip` (§14.2, panel) tidak punya kolom di skema final — disimpan di
// dalam input_json (merge key `ip`) agar tidak menulis DDL sendiri.

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../lib/db.js';
import { genId } from '../../lib/ids.js';
import { VmPanelError, PERMISSION_DENIED, VALIDATION } from '../../lib/errors.js';
import { makeRedactor } from '../../lib/redact.js';
import { randomToken } from '../../lib/crypto.js';
import { createLogger } from '../../lib/log.js';

const INPUT_MAX_BYTES = 8 * 1024; // §14.2: input max 8KB
const PURGE_META_PREFIX = 'purge_request:';
const DEFAULT_PURGE_TTL_MS = 10 * 60 * 1000; // token purge kedaluwarsa 10 menit
const PURGE_OP = 'AUDIT_PURGE';

// Recreate trigger no_delete persis definisi lib/schema.js (setelah DROP sementara).
const NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only (no delete)');
END`;

const INSERT_SQL = `INSERT INTO audit_events (
  at, actor, user_id, role, project_id, service_id, operation, input_json,
  status_before, status_after, revision_before, revision_after,
  pid_old, pid_new, port, backup_id, deployment_id, runner_id,
  recovery_action, error, result
) VALUES (
  @at, @actor, @userId, @role, @projectId, @serviceId, @operation, @inputJson,
  @statusBefore, @statusAfter, @revisionBefore, @revisionAfter,
  @pidOld, @pidNew, @port, @backupId, @deploymentId, @runnerId,
  @recoveryAction, @error, @result
)`;

function nowIso() {
  return new Date().toISOString();
}

/** Normalisasi field teks: null/undefined/'' → null, selainnya → String. */
function normText(v) {
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

/** Potong string agar ≤ maxBytes (aman terhadap multibyte, selalu konvergen). */
function clampUtf8(s, maxBytes) {
  let out = s;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, Math.floor((out.length * 3) / 4));
  }
  return out;
}

/** input + ip → JSON string ter-redaksi, max 8KB. */
function normalizeInputJson(redactor, input, ip) {
  const raw = input === undefined || input === null ? {} : input;
  const redacted = redactor(raw);
  let toStore = redacted;
  const ipNorm = normText(ip);
  if (ipNorm !== null) {
    toStore =
      redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted)
        ? { ...redacted, ip: ipNorm }
        : { value: redacted, ip: ipNorm };
  }
  let s;
  try {
    s = JSON.stringify(toStore);
  } catch {
    s = JSON.stringify({ unserializable: true });
  }
  return clampUtf8(s, INPUT_MAX_BYTES);
}

function sha256Hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

/** Map row audit_events (snake_case) → objek API (camelCase, input di-parse). */
function mapRow(r) {
  if (!r) return null;
  let input = r.input_json;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      /* biarkan string mentah */
    }
  }
  return {
    id: r.id,
    at: r.at,
    actor: r.actor,
    userId: r.user_id,
    role: r.role,
    projectId: r.project_id,
    serviceId: r.service_id,
    operation: r.operation,
    input,
    statusBefore: r.status_before,
    statusAfter: r.status_after,
    revisionBefore: r.revision_before,
    revisionAfter: r.revision_after,
    pidOld: r.pid_old,
    pidNew: r.pid_new,
    port: r.port,
    backupId: r.backup_id,
    deploymentId: r.deployment_id,
    runnerId: r.runner_id,
    recoveryAction: r.recovery_action,
    error: r.error,
    result: r.result,
  };
}

export class AuditManager {
  /**
   * @param {{dataDir: string, redactor?: (input: any) => any,
   *          logDir?: string, purgeTtlMs?: number}} opts
   */
  constructor({ dataDir, redactor, logDir, purgeTtlMs } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'AuditManager: dataDir wajib');
    }
    this.#h = openDatabase(join(dataDir, 'audit.db'), { schemaName: 'audit' });
    this.#h.migrate();
    this.#redactor = redactor ?? makeRedactor();
    this.#purgeTtlMs =
      Number.isInteger(purgeTtlMs) && purgeTtlMs > 0 ? purgeTtlMs : DEFAULT_PURGE_TTL_MS;
    this.#logger = logDir
      ? createLogger({ dir: logDir, name: 'manager', redactor: this.#redactor })
      : null;
    this.#insEvent = this.#h.db.prepare(INSERT_SQL);
    this.#delOlderThan = this.#h.db.prepare('DELETE FROM audit_events WHERE at < ?');
  }

  #h;
  #redactor;
  #purgeTtlMs;
  #logger;
  #insEvent;
  #delOlderThan;

  /**
   * Append satu event audit (§14.2). Timestamp UTC ISO diisi otomatis.
   * input & error dilewatkan redactor sebelum disimpan.
   * @returns {{id: number, at: string}}
   */
  append(event = {}) {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new VmPanelError(VALIDATION, 'audit append: event harus object');
    }
    const operation = normText(event.operation);
    if (!operation) {
      throw new VmPanelError(VALIDATION, 'audit append: operation wajib');
    }
    const at = nowIso();
    const row = {
      at,
      actor: normText(event.actor),
      userId: normText(event.userId),
      role: normText(event.role),
      projectId: normText(event.projectId),
      serviceId: normText(event.serviceId),
      operation,
      inputJson: normalizeInputJson(this.#redactor, event.input, event.ip),
      statusBefore: normText(event.statusBefore),
      statusAfter: normText(event.statusAfter),
      revisionBefore: normText(event.revisionBefore),
      revisionAfter: normText(event.revisionAfter),
      pidOld: normText(event.pidOld),
      pidNew: normText(event.pidNew),
      port: normText(event.port) === null ? null : Number(event.port),
      backupId: normText(event.backupId),
      deploymentId: normText(event.deploymentId),
      runnerId: normText(event.runnerId),
      recoveryAction: normText(event.recoveryAction),
      error: normText(event.error) === null ? null : this.#redactor(String(event.error)),
      result: normText(event.result),
    };
    const info = this.#insEvent.run(row);
    this.#logger?.info('audit.append', { operation, actor: row.actor, projectId: row.projectId });
    return { id: Number(info.lastInsertRowid), at };
  }

  /**
   * List event: {limit=50, offset, actor, operation, projectId, from, to}
   * → {rows: object[], total}. Urutan terbaru dulu (id DESC).
   */
  list({ limit = 50, offset = 0, actor, operation, projectId, from, to } = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new VmPanelError(VALIDATION, 'audit list: limit harus integer >= 1');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new VmPanelError(VALIDATION, 'audit list: offset harus integer >= 0');
    }
    const where = [];
    const params = [];
    const eq = (col, val) => {
      where.push(`${col} = ?`);
      params.push(String(val));
    };
    if (actor !== undefined && actor !== null && actor !== '') eq('actor', actor);
    if (operation !== undefined && operation !== null && operation !== '') eq('operation', operation);
    if (projectId !== undefined && projectId !== null && projectId !== '') eq('project_id', projectId);
    if (from !== undefined && from !== null && from !== '') {
      where.push('at >= ?');
      params.push(String(from));
    }
    if (to !== undefined && to !== null && to !== '') {
      where.push('at <= ?');
      params.push(String(to));
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = this.#h.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events${whereSql}`)
      .get(...params).c;
    const rows = this.#h.db
      .prepare(`SELECT * FROM audit_events${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { rows: rows.map(mapRow), total };
  }

  /**
   * Fase 1 purge: validasi reason + beforeIso, hitung jumlah row yang akan
   * terhapus (at < beforeIso), simpan request ke meta audit.db.
   * @returns {{requestId, confirmToken, summary, expiresAt, reason, beforeIso}}
   */
  purgeRequest({ reason, actor, beforeIso } = {}) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new VmPanelError(VALIDATION, 'audit purge: reason wajib diisi');
    }
    const actorNorm = normText(actor);
    if (actorNorm === null) {
      throw new VmPanelError(VALIDATION, 'audit purge: actor wajib');
    }
    if (typeof beforeIso !== 'string' || Number.isNaN(Date.parse(beforeIso))) {
      throw new VmPanelError(VALIDATION, 'audit purge: beforeIso harus ISO date valid');
    }
    const summary = this.#h.db
      .prepare('SELECT COUNT(*) AS c FROM audit_events WHERE at < ?')
      .get(beforeIso).c;
    const requestId = genId('pur');
    const confirmToken = randomToken(32);
    const expiresAt = new Date(Date.now() + this.#purgeTtlMs).toISOString();
    // Token disimpan sebagai hash — meta audit.db tidak boleh memuat token plaintext.
    this.#h.setMeta(
      PURGE_META_PREFIX + requestId,
      JSON.stringify({
        requestId,
        tokenHash: sha256Hex(confirmToken),
        reason: reason.trim(),
        actor: actorNorm,
        beforeIso,
        summary,
        createdAt: nowIso(),
        expiresAt,
        used: false,
      }),
    );
    this.#logger?.warn('audit.purgeRequest', { requestId, summary, beforeIso, actor: actorNorm });
    return { requestId, confirmToken, summary, expiresAt, reason: reason.trim(), beforeIso };
  }

  /**
   * Fase 2 purge: verifikasi requestId + token + expiry + reason → DELETE
   * rows (at < beforeIso) dalam tx dengan trigger no_delete diturunkan
   * sementara, INSERT event AUDIT_PURGE (metadata saja), tandai request used.
   * Kegagalan verifikasi apa pun → PERMISSION_DENIED.
   * @returns {{deleted: number}}
   */
  purgeExecute({ requestId, confirmToken, actor } = {}) {
    const actorNorm = normText(actor);
    if (!requestId || typeof confirmToken !== 'string' || confirmToken.length === 0) {
      throw new VmPanelError(PERMISSION_DENIED, 'audit purge execute: requestId + confirmToken wajib');
    }
    const raw = this.#h.getMeta(PURGE_META_PREFIX + requestId);
    if (!raw) {
      throw new VmPanelError(PERMISSION_DENIED, 'audit purge execute: request tidak dikenal');
    }
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      throw new VmPanelError(PERMISSION_DENIED, 'audit purge execute: request korup');
    }
    if (req.used) {
      throw new VmPanelError(PERMISSION_DENIED, 'audit purge execute: request sudah dipakai');
    }
    if (!req.expiresAt || Date.parse(req.expiresAt) < Date.now()) {
      throw new VmPanelError(PERMISSION_DENIED, 'audit purge execute: request kedaluwarsa');
    }
    if (typeof req.reason !== 'string' || req.reason.trim().length === 0) {
      throw new VmPanelError(PERMISSION_DENIED, 'audit purge execute: reason kosong');
    }
    if (req.tokenHash !== sha256Hex(confirmToken)) {
      throw new VmPanelError(PERMISSION_DENIED, 'audit purge execute: token tidak cocok');
    }

    const beforeIso = req.beforeIso;
    // tx(fn) mengeksekusi transaksi langsung (BEGIN IMMEDIATE) dan mengembalikan
    // nilai fn — DELETE + event AUDIT_PURGE atomik.
    const deleted = this.#h.tx(() => {
      // Satu-satunya jalur legal menembus append-only: DROP trigger sementara
      // DI DALAM tx yang sama dengan DELETE + event AUDIT_PURGE (atomik; DDL
      // SQLite transactional — rollback mengembalikan trigger otomatis).
      this.#h.db.exec('DROP TRIGGER IF EXISTS no_delete');
      try {
        const info = this.#delOlderThan.run(beforeIso);
        const deletedCount = info.changes;
        this.#insEvent.run({
          at: nowIso(),
          actor: actorNorm ?? req.actor,
          userId: null,
          role: null,
          projectId: null,
          serviceId: null,
          operation: PURGE_OP,
          // Metadata range + jumlah — TIDAK berisi isi row yang dihapus.
          inputJson: normalizeInputJson(this.#redactor, {
            requestId: req.requestId,
            reason: req.reason,
            beforeIso,
            summary: req.summary,
            deleted: deletedCount,
          }),
          statusBefore: null,
          statusAfter: 'purged',
          revisionBefore: null,
          revisionAfter: null,
          pidOld: null,
          pidNew: null,
          port: null,
          backupId: null,
          deploymentId: null,
          runnerId: null,
          recoveryAction: null,
          error: null,
          result: 'ok',
        });
        this.#h.setMeta(
          PURGE_META_PREFIX + requestId,
          JSON.stringify({
            ...req,
            used: true,
            executedAt: nowIso(),
            executedBy: actorNorm,
            deleted: deletedCount,
          }),
        );
        return deletedCount;
      } finally {
        this.#h.db.exec(NO_DELETE_TRIGGER_SQL);
      }
    });
    this.#logger?.warn('audit.purgeExecute', { requestId, deleted, actor: actorNorm });
    return { deleted };
  }

  /** Tutup koneksi DB (untuk shutdown/test). */
  close() {
    this.#h.close();
  }
}
