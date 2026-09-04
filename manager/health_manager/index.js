// manager/health_manager/index.js — HealthManager (docs/DESIGN.md §7A).
// health.db via openDatabase({schemaName:'health'}); DDL final ada di lib/schema.js
// (health_checks, health_state, alerts) — tidak ditulis duplikat di sini.
// TANPA scheduler internal: supervisor (lane lain) yang memanggil runCheck +
// recordCheck. Semua tipe check ber-timeout → tidak memblok event loop lama.
// Semua string error di-redact (lib/redact.js) lalu di-clamp 2KB sebelum disimpan.

import { join } from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

import { openDatabase } from '../../lib/db.js';
import { VmPanelError, VALIDATION } from '../../lib/errors.js';
import { makeRedactor } from '../../lib/redact.js';

const HTTP_TIMEOUT_MS = 5000; // §7A.1 http default
const TCP_TIMEOUT_MS = 3000; // §7A.1 tcp default
const CMD_TIMEOUT_MS = 15000; // §7A.1 command default
const DB_BUSY_TIMEOUT_MS = 5000;
const HTTP_BODY_CAP = 64 * 1024; // body dipotong sebelum diuji regex
const MAX_PATTERN_LEN = 256; // §7A.1: expectContent dibatasi 256 char
const ERROR_MAX_LEN = 2048; // semua string error di-clamp 2KB
const FAIL_THRESHOLD = 3; // consecutive_failures >= 3 → 'failed'
const LIST_LIMIT_MAX = 1000;
// §7A.2: transisi manual oleh supervisor (bukan hasil check)
const MANUAL_STATUSES = new Set(['starting', 'stopped', 'disabled', 'recovering', 'degraded']);

function errMsg(e) {
  if (e && typeof e.message === 'string' && e.message.length > 0) return e.message;
  return String(e);
}

function clamp2k(s) {
  return s.length > ERROR_MAX_LEN ? s.slice(0, ERROR_MAX_LEN) : s;
}

function assertTimeoutMs(v, label, fallback) {
  const ms = v ?? fallback;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new VmPanelError(VALIDATION, `${label}: timeoutMs wajib angka > 0`);
  }
  return ms;
}

/* ---------------- check runners (murni, tanpa DB) ---------------- */

/** http: GET + status match + optional expectContent regex (body max 64KB). */
async function httpCheck(check) {
  const url = check.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new VmPanelError(VALIDATION, 'http check: url wajib string tidak kosong');
  }
  const expectStatus = check.expectStatus ?? 200;
  if (!Number.isInteger(expectStatus)) {
    throw new VmPanelError(VALIDATION, 'http check: expectStatus wajib integer');
  }
  let re = null;
  if (check.expectContent != null) {
    if (typeof check.expectContent !== 'string' || check.expectContent.length === 0) {
      throw new VmPanelError(VALIDATION, 'http check: expectContent wajib string tidak kosong');
    }
    if (check.expectContent.length > MAX_PATTERN_LEN) {
      throw new VmPanelError(
        VALIDATION,
        `http check: panjang pattern expectContent > ${MAX_PATTERN_LEN} char`,
      );
    }
    try {
      re = new RegExp(check.expectContent); // compile sekali per check
    } catch (e) {
      throw new VmPanelError(VALIDATION, `http check: expectContent bukan regex valid: ${errMsg(e)}`);
    }
  }
  const timeoutMs = assertTimeoutMs(check.timeoutMs, 'http check', HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== expectStatus) {
      try {
        await res.text(); // drain agar socket bebas
      } catch {
        /* best-effort */
      }
      return { ok: false, error: `http status ${res.status} != expectStatus ${expectStatus}` };
    }
    if (re) {
      let body;
      try {
        body = await res.text();
      } catch (e) {
        return { ok: false, error: `http body read gagal: ${errMsg(e)}` };
      }
      const capped = body.length > HTTP_BODY_CAP ? body.slice(0, HTTP_BODY_CAP) : body;
      try {
        if (!re.test(capped)) {
          return { ok: false, error: 'http body tidak cocok dengan expectContent' };
        }
      } catch (e) {
        // guard ReDoS/regex runtime error → fail, bukan crash
        return { ok: false, error: `http regex exec gagal: ${errMsg(e)}` };
      }
      return { ok: true, error: null };
    }
    try {
      await res.text();
    } catch {
      /* best-effort */
    }
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: `http request gagal: ${errMsg(e)}` };
  }
}

/** tcp: net.connect host:port; destroy socket setelah connect ok. */
function tcpCheck(check) {
  const host = check.host ?? '127.0.0.1';
  if (typeof host !== 'string' || host.length === 0) {
    throw new VmPanelError(VALIDATION, 'tcp check: host wajib string');
  }
  const { port } = check;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new VmPanelError(VALIDATION, 'tcp check: port wajib integer 1-65535');
  }
  const timeoutMs = assertTimeoutMs(check.timeoutMs, 'tcp check', TCP_TIMEOUT_MS);
  return new Promise((resolve) => {
    let socket;
    try {
      socket = net.connect({ host, port });
    } catch (e) {
      resolve({ ok: false, error: `tcp connect gagal: ${errMsg(e)}` });
      return;
    }
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, null));
    socket.once('timeout', () => finish(false, `tcp timeout setelah ${timeoutMs}ms`));
    socket.once('error', (e) => finish(false, `tcp connect gagal: ${errMsg(e)}`));
  });
}

/** command: execFile argv (NO SHELL); ok = exit 0; timeout → fail. */
function commandCheck(check) {
  const { argv } = check;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
    throw new VmPanelError(VALIDATION, 'command check: argv wajib array of string (NO SHELL)');
  }
  const timeoutMs = assertTimeoutMs(check.timeoutMs, 'command check', CMD_TIMEOUT_MS);
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: timeoutMs, windowsHide: true, shell: false },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, error: null });
          return;
        }
        if (err.killed) {
          resolve({ ok: false, error: `command timeout setelah ${timeoutMs}ms (killed)` });
          return;
        }
        if (typeof err.code === 'number') {
          const tail =
            typeof stderr === 'string' && stderr.length > 0
              ? `: ${stderr.trim().slice(0, 200)}`
              : '';
          resolve({ ok: false, error: `command exit ${err.code}${tail}` });
          return;
        }
        resolve({ ok: false, error: `command gagal: ${errMsg(err)}` });
      },
    );
  });
}

/** db: open readonly + pragma quick_check; open gagal → not ok (JANGAN throw keluar). */
function dbCheck(check) {
  const dbPath = check.dbPath;
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new VmPanelError(VALIDATION, 'db check: dbPath wajib string tidak kosong');
  }
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, timeout: DB_BUSY_TIMEOUT_MS });
    const rows = db.pragma('quick_check');
    const ok = Array.isArray(rows) && rows.length === 1 && rows[0].quick_check === 'ok';
    if (ok) return { ok: true, error: null };
    const detail = Array.isArray(rows)
      ? JSON.stringify(rows).slice(0, 200)
      : 'hasil quick_check tidak dikenal';
    return { ok: false, error: `db quick_check tidak ok: ${detail}` };
  } catch (e) {
    // file hilang / bukan sqlite / lock → not ok, jangan throw keluar
    return { ok: false, error: `db check gagal: ${errMsg(e)}` };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* biarkan */
      }
    }
  }
}

/** process: kill(pid, 0) — ESRCH → tidak ada; EPERM → ada (tapi tanpa izin). */
function processCheck(check) {
  const { pid } = check;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new VmPanelError(VALIDATION, 'process check: pid wajib integer > 0');
  }
  try {
    process.kill(pid, 0); // signal 0 = existence check saja
    return { ok: true, error: null };
  } catch (e) {
    if (e && e.code === 'EPERM') return { ok: true, error: null };
    if (e && e.code === 'ESRCH') return { ok: false, error: `pid ${pid} tidak ditemukan` };
    return { ok: false, error: `process check gagal: ${errMsg(e)}` };
  }
}

/* ---------------- HealthManager ---------------- */

export class HealthManager {
  #h;
  #redact;
  #closed = false;
  #stmtGetState;
  #stmtUpsertState;
  #stmtUpsertManual;
  #stmtInsertCheck;
  #stmtListChecks;
  #stmtInsertAlert;
  #stmtResolveAlert;

  /** @param {{dataDir: string}} opts */
  constructor({ dataDir } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'HealthManager: dataDir wajib');
    }
    this.#h = openDatabase(join(dataDir, 'health.db'), { schemaName: 'health' });
    this.#h.migrate();
    this.#redact = makeRedactor();

    const db = this.#h.db;
    this.#stmtGetState = db.prepare(
      `SELECT service_id, status, last_check_at, last_healthy_at, consecutive_failures
       FROM health_state WHERE service_id = ?`,
    );
    this.#stmtUpsertState = db.prepare(
      `INSERT INTO health_state (service_id, status, last_check_at, last_healthy_at, consecutive_failures)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(service_id) DO UPDATE SET
         status = excluded.status,
         last_check_at = excluded.last_check_at,
         last_healthy_at = excluded.last_healthy_at,
         consecutive_failures = excluded.consecutive_failures`,
    );
    this.#stmtUpsertManual = db.prepare(
      `INSERT INTO health_state (service_id, status, last_check_at, last_healthy_at, consecutive_failures)
       VALUES (?, ?, NULL, NULL, 0)
       ON CONFLICT(service_id) DO UPDATE SET status = excluded.status`,
    );
    this.#stmtInsertCheck = db.prepare(
      `INSERT INTO health_checks
         (project_id, service_id, check_type, at, latency_ms, result, status, error, consecutive_failures, recovery_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#stmtListChecks = db.prepare(
      `SELECT id, project_id, service_id, check_type, at, latency_ms, result, status,
              error, consecutive_failures, recovery_action
       FROM health_checks WHERE service_id = ? ORDER BY id DESC LIMIT ?`,
    );
    this.#stmtInsertAlert = db.prepare(
      'INSERT INTO alerts (project_id, level, code, message, at, resolved_at) VALUES (?, ?, ?, ?, ?, NULL)',
    );
    this.#stmtResolveAlert = db.prepare(
      'UPDATE alerts SET resolved_at = ? WHERE code = ? AND resolved_at IS NULL',
    );
  }

  /**
   * Jalankan satu check (tanpa menulis DB). Return {ok, latencyMs, type, result, error}.
   * Type tidak dikenal → throw VALIDATION.
   */
  async runCheck({ serviceId, projectId, check } = {}) {
    if (!check || typeof check !== 'object') {
      throw new VmPanelError(VALIDATION, 'runCheck: check wajib object');
    }
    const type = check.type;
    const t0 = performance.now();
    let out;
    switch (type) {
      case 'http':
        out = await httpCheck(check);
        break;
      case 'tcp':
        out = await tcpCheck(check);
        break;
      case 'command':
        out = await commandCheck(check);
        break;
      case 'db':
        out = dbCheck(check);
        break;
      case 'process':
        out = processCheck(check);
        break;
      default:
        throw new VmPanelError(
          VALIDATION,
          `runCheck: tipe check tidak dikenal '${String(type)}'`,
          { type },
        );
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const ok = out.ok === true;
    return { ok, latencyMs, type, result: ok ? 'ok' : 'fail', error: out.error ?? null };
  }

  /**
   * Catat hasil check: INSERT health_checks + UPSERT health_state dalam satu tx.
   * ok → consecutive_failures=0, status 'healthy', last_healthy_at=now.
   * fail → consecutive++, status 'unhealthy' (<3) atau 'failed' (>=3).
   * Return {id, at, status, consecutiveFailures}.
   */
  recordCheck({ serviceId, projectId, check, outcome } = {}) {
    this.#assertOpen();
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      throw new VmPanelError(VALIDATION, 'recordCheck: serviceId wajib string tidak kosong');
    }
    const type = check && check.type;
    if (typeof type !== 'string' || type.length === 0) {
      throw new VmPanelError(VALIDATION, 'recordCheck: check.type wajib string');
    }
    if (!outcome || typeof outcome.ok !== 'boolean') {
      throw new VmPanelError(VALIDATION, 'recordCheck: outcome.ok wajib boolean');
    }
    const ok = outcome.ok;
    const at = new Date().toISOString(); // UTC ISO
    const latencyMs = Number.isFinite(outcome.latencyMs)
      ? Math.max(0, Math.round(outcome.latencyMs))
      : null;
    // redact dulu, baru clamp 2KB
    const error = outcome.error == null ? null : clamp2k(this.#redact(String(outcome.error)));
    const result = ok ? 'ok' : 'fail';

    return this.#h.tx(() => {
      const cur = this.#stmtGetState.get(serviceId);
      let consecutive;
      let status;
      let lastHealthyAt;
      if (ok) {
        consecutive = 0;
        status = 'healthy';
        lastHealthyAt = at;
      } else {
        consecutive = (cur ? (cur.consecutive_failures ?? 0) : 0) + 1;
        status = consecutive >= FAIL_THRESHOLD ? 'failed' : 'unhealthy';
        lastHealthyAt = cur ? cur.last_healthy_at : null;
      }
      this.#stmtUpsertState.run(serviceId, status, at, lastHealthyAt, consecutive);
      const info = this.#stmtInsertCheck.run(
        projectId ?? null,
        serviceId,
        type,
        at,
        latencyMs,
        result,
        status,
        error,
        consecutive,
        null, // recovery_action diisi supervisor
      );
      return { id: Number(info.lastInsertRowid), at, status, consecutiveFailures: consecutive };
    });
  }

  /** health_state row, atau {status:'unknown'} jika belum pernah di-record. */
  getStatus(serviceId) {
    this.#assertOpen();
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      throw new VmPanelError(VALIDATION, 'getStatus: serviceId wajib string tidak kosong');
    }
    const row = this.#stmtGetState.get(serviceId);
    if (row) return row;
    return {
      service_id: serviceId,
      status: 'unknown',
      last_check_at: null,
      last_healthy_at: null,
      consecutive_failures: 0,
    };
  }

  /** Transisi manual oleh supervisor: starting/stopped/disabled/recovering/degraded. */
  setStatus(serviceId, status) {
    this.#assertOpen();
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      throw new VmPanelError(VALIDATION, 'setStatus: serviceId wajib string tidak kosong');
    }
    if (!MANUAL_STATUSES.has(status)) {
      throw new VmPanelError(
        VALIDATION,
        `setStatus: status '${String(status)}' bukan status transisi manual`,
        { allowed: [...MANUAL_STATUSES] },
      );
    }
    this.#stmtUpsertManual.run(serviceId, status);
    return this.getStatus(serviceId);
  }

  /** Rows check terbaru dulu (ORDER BY id DESC). */
  listChecks({ serviceId, limit = 50 } = {}) {
    this.#assertOpen();
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      throw new VmPanelError(VALIDATION, 'listChecks: serviceId wajib string tidak kosong');
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new VmPanelError(VALIDATION, 'listChecks: limit wajib integer >= 1');
    }
    return this.#stmtListChecks.all(serviceId, Math.min(limit, LIST_LIMIT_MAX));
  }

  /** Naikkan alert (message direduksi + clamp 2KB). Return {id, at}. */
  raiseAlert({ projectId, level, code, message } = {}) {
    this.#assertOpen();
    if (typeof level !== 'string' || level.length === 0) {
      throw new VmPanelError(VALIDATION, 'raiseAlert: level wajib string tidak kosong');
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new VmPanelError(VALIDATION, 'raiseAlert: code wajib string tidak kosong');
    }
    const at = new Date().toISOString();
    const msg = message == null ? null : clamp2k(this.#redact(String(message)));
    const info = this.#stmtInsertAlert.run(projectId ?? null, level, code, msg, at);
    return { id: Number(info.lastInsertRowid), at };
  }

  /** Resolve semua alert belum-resolved dengan code tsb. Return {resolved, at}. */
  resolveAlert(code) {
    this.#assertOpen();
    if (typeof code !== 'string' || code.length === 0) {
      throw new VmPanelError(VALIDATION, 'resolveAlert: code wajib string tidak kosong');
    }
    const at = new Date().toISOString();
    const info = this.#stmtResolveAlert.run(at, code);
    return { resolved: info.changes, at };
  }

  /** Tutup DB (idempotent). */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#h.close();
  }

  #assertOpen() {
    if (this.#closed) {
      throw new VmPanelError(VALIDATION, 'HealthManager: sudah close');
    }
  }
}
