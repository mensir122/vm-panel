// manager/service_manager/index.js — ServiceManager (docs/DESIGN.md §6, §6A).
// services.db via lib/db.js openDatabase({schemaName:'services'}) — tabel
// services, service_supervisor_state, deployment_queue, ports; DDL inti dari
// lib/schema.js (tidak ditulis ulang di sini). Kolom `config` (TEXT JSON) hanya
// di-ensure aditif & idempotent via ALTER TABLE (bukan DDL baru).
//
// Validasi project: koneksi read-only sendiri ke projects.db via constructor
// option `projectsDbPath` (opsional; tanpa itu, validasi dilewati).
//
// CATATAN skema: tabel `services` tidak punya kolom `type` — tipe service,
// rootDir, healthCheck, startSpec, restartPolicy disimpan sebagai JSON di
// kolom `config`.

import fs from 'node:fs';
import path from 'node:path';

import { openDatabase } from '../../lib/db.js';
import { genId, isValidId } from '../../lib/ids.js';
import {
  VmPanelError,
  VALIDATION,
  NOT_FOUND,
  PORT_IN_USE,
} from '../../lib/errors.js';
import { ADAPTERS, createAdapter } from '../adapters/index.js';

function nowIso() {
  return new Date().toISOString();
}

/** Status legal untuk transisi eksplisit via setStatus (#31b). */
const SERVICE_STATUSES = new Set(['stopped', 'running', 'failed', 'disabled']);

/** Logger fallback — rekonsiliasi tidak boleh crash tanpa logger ter-injeksi. */
const NOOP_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function safeJsonParse(text, fallback = null) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * ServiceManager — lifecycle service: create/start/stop/restart/health,
 * registry port, state supervisor, enable/disable.
 */
export class ServiceManager {
  /**
   * @param {{
   *   dataDir: string,
   *   processManager: import('../process_manager/index.js').ProcessManager,
   *   adapters?: typeof ADAPTERS,
   *   auditManager?: object|null,
   *   projectsDbPath?: string|null,
   *   logger?: {debug,info,warn,error}|null,
   * }} opts
   */
  constructor({
    dataDir,
    processManager,
    adapters = ADAPTERS,
    auditManager = null,
    projectsDbPath = null,
    logger = null,
  }) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'ServiceManager: dataDir wajib');
    }
    if (!processManager || typeof processManager.startProcess !== 'function') {
      throw new VmPanelError(VALIDATION, 'ServiceManager: processManager wajib');
    }
    this.dataDir = path.resolve(dataDir);
    this.processManager = processManager;
    this.adapters = adapters;
    this.auditManager = auditManager;
    this.logger = logger ?? NOOP_LOGGER;
    fs.mkdirSync(this.dataDir, { recursive: true });

    const opened = openDatabase(path.join(this.dataDir, 'services.db'), {
      schemaName: 'services',
    });
    this.store = opened;
    opened.migrate();

    // Ensure kolom aditif & idempotent (ALTER TABLE, bukan DDL baru):
    //  - `config`          : JSON config service
    //  - `start_time_hint` : #30 creation-time proses anak (epoch ms) — dipakai
    //    isAlive() sebagai guard PID-reuse lintas restart manager.
    const cols = this.store.db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
    if (!cols.includes('config')) {
      this.store.db.exec('ALTER TABLE services ADD COLUMN config TEXT');
    }
    if (!cols.includes('start_time_hint')) {
      this.store.db.exec('ALTER TABLE services ADD COLUMN start_time_hint INTEGER');
    }

    // Validasi project: koneksi read-only sendiri ke projects.db.
    this._projectsRo = null;
    if (projectsDbPath && fs.existsSync(projectsDbPath)) {
      try {
        this._projectsRo = openDatabase(projectsDbPath, { schemaName: 'projects' });
      } catch {
        this._projectsRo = null; // validasi project dilewati bila tak bisa dibuka
      }
    }

    // Release-on-exit wiring (§6A.2 anti port-leak): child exit (crash, kill
    // manual) → ports row service dilepas otomatis. Gagal handler TIDAK boleh
    // mengganggu lifecycle process (diamkan). Idempotent terhadap stopService
    // (DELETE ports row yang mungkin sudah hilang).
    if (typeof this.processManager.setExitHandler === 'function') {
      this.processManager.setExitHandler((serviceId, exitInfo) => {
        try {
          this.releasePort(serviceId);
        } catch {
          /* DB sudah close / service row sudah dihapus — abaikan */
        }
        try {
          const rec = this.store.db.prepare('SELECT status FROM services WHERE id = ?').get(serviceId);
          if (rec && rec.status === 'running') {
            const now = nowIso();
            const exitCode = exitInfo?.exitCode ?? null;
            // #32 — reason dari exit-classification ProcessManager (mis.
            // 'port_taken_at_spawn'); null = crash biasa.
            const reason = typeof exitInfo?.reason === 'string' ? exitInfo.reason : null;
            this.store.db
              .prepare(
                `UPDATE services
                 SET status = 'failed', pid = NULL, start_time_hint = NULL,
                     last_exit_code = ?, updated_at = ?
                 WHERE id = ? AND status = 'running'`,
              )
              .run(exitCode, now, serviceId);
            try {
              this.setSupervisorState(serviceId, {
                state: 'failed',
                lastEvent: reason ?? 'crashed',
              });
            } catch {}
            this._audit('processCrashed', {
              actor: 'system',
              serviceId,
              result: 'ok',
              input: {
                exitCode,
                signal: exitInfo?.signal ?? null,
                reason,
                lifetimeMs: exitInfo?.lifetimeMs ?? null,
                port: exitInfo?.port ?? null,
                // Pesan bedakan crash biasa vs port-tabrakan-lekas (§#32).
                message:
                  reason === 'port_taken_at_spawn'
                    ? `service ${serviceId} exit ${exitCode} <5s; port ${exitInfo?.port} masih dipegang proses lain — kemungkinan besar tabrakan port, bukan bug aplikasi`
                    : `service ${serviceId} crash (exit ${exitCode})`,
              },
            });
          }
        } catch {
          /* best-effort exit sync */
        }
      });
    }
  }

  _projectExists(projectId) {
    if (!this._projectsRo) return true; // tanpa projects.db: tidak bisa divalidasi
    const row = this._projectsRo.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId);
    return Boolean(row);
  }

  _projectWorkspacePath(projectId) {
    if (!this._projectsRo) return null;
    const row = this._projectsRo.db
      .prepare('SELECT workspace_path FROM projects WHERE id = ?')
      .get(projectId);
    return row?.workspace_path ?? null;
  }

  _rowToRecord(row) {
    if (!row) return null;
    const config = safeJsonParse(row.config, {}) ?? {};
    return {
      id: row.id,
      projectId: row.project_id ?? null,
      name: row.name ?? null,
      type: config.type ?? null,
      status: row.status ?? null,
      pid: row.pid ?? null,
      /** #30 creation-time proses anak (epoch ms) — guard PID-reuse isAlive(). */
      startTimeHint: row.start_time_hint ?? null,
      port: row.port ?? null,
      enabled: row.enabled === 1,
      restartCount: row.restart_count ?? 0,
      lastExitCode: row.last_exit_code ?? null,
      startedAt: row.started_at ?? null,
      updatedAt: row.updated_at ?? null,
      config,
      rootDir: config.rootDir ?? null,
      healthCheck: config.healthCheck ?? null,
      startSpec: config.startSpec ?? null,
      restartPolicy: config.restartPolicy ?? null,
    };
  }

  /**
   * Buat service: INSERT services (status 'stopped', enabled 1) + ports row.
   * config JSON diisi {type, rootDir (default workspacePath project), healthCheck,
   * restartPolicy, startSpec}.
   * @returns {object} record service lengkap
   */
  createService({
    projectId,
    name,
    type,
    port,
    config = {},
    startSpec = null,
    healthCheck = null,
    restartPolicy = null,
  } = {}) {
    if (!isValidId(projectId, 'prj_')) {
      throw new VmPanelError(VALIDATION, `format projectId tidak valid: ${String(projectId)}`, {
        projectId,
      });
    }
    if (!this._projectExists(projectId)) {
      throw new VmPanelError(NOT_FOUND, `project tidak ditemukan: ${projectId}`, { projectId });
    }
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
      throw new VmPanelError(VALIDATION, 'name service tidak valid', { name });
    }
    if (!(type in this.adapters)) {
      throw new VmPanelError(VALIDATION, `type adapter tidak dikenal: ${String(type)}`, {
        type,
        known: Object.keys(this.adapters),
      });
    }
    this.processManager.assertPortLegal(port);

    // config JSON (kontrak adapter.startSpec): rootDir default = workspacePath
    // project (untuk static), healthCheck untuk health lane. Key tambahan dari
    // config param (mis. `main` hasil inspect DeploymentManager) dipertahankan
    // — NodeAdapter/PythonAdapter.startSpec membacanya (cfg.main).
    const mergedConfig = {
      ...(config ?? {}),
      type,
      rootDir: config?.rootDir ?? startSpec?.rootDir ?? this._projectWorkspacePath(projectId) ?? null,
      healthCheck: config?.healthCheck ?? healthCheck ?? null,
      restartPolicy: restartPolicy ?? config?.restartPolicy ?? 'on-failure',
      startSpec: startSpec ?? config?.startSpec ?? null,
    };

    const id = genId('svc_');
    const now = nowIso();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO services
             (id, project_id, name, status, pid, port, enabled, restart_count, config, updated_at)
           VALUES (?, ?, ?, 'stopped', NULL, ?, 1, 0, ?, ?)`,
        )
        .run(id, projectId, name, port, JSON.stringify(mergedConfig), now);
      this.store.db
        .prepare(
          `INSERT INTO ports (port, service_id, bound_host, bound_at)
           VALUES (?, ?, '127.0.0.1', ?)
           ON CONFLICT(port) DO NOTHING`,
        )
        .run(port, id, now);
    });
    return this.getService(id);
  }

  getService(serviceId) {
    if (!isValidId(serviceId, 'svc_')) {
      throw new VmPanelError(VALIDATION, `format service id tidak valid: ${String(serviceId)}`, {
        serviceId,
      });
    }
    const row = this.store.db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
    if (!row) {
      throw new VmPanelError(NOT_FOUND, `service tidak ditemukan: ${serviceId}`, { serviceId });
    }
    return this._rowToRecord(row);
  }

  listServices({ status = null, projectId = null } = {}) {
    const where = [];
    const params = [];
    if (status != null) {
      where.push('status = ?');
      params.push(String(status));
    }
    if (projectId != null) {
      where.push('project_id = ?');
      params.push(String(projectId));
    }
    const sql = `SELECT * FROM services ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at`;
    return this.store.db
      .prepare(sql)
      .all(...params)
      .map((r) => this._rowToRecord(r));
  }

  /**
   * Update parsial config JSON service (merge dangkal). Dipakai
   * DeploymentManager untuk menyinkronkan config.rootDir/config.main service
   * yang di-reuse saat re-deploy (revision baru → clone/entry baru).
   * Patch key dengan nilai null/undefined diabaikan (tidak menimpa existing).
   * @param {string} serviceId
   * @param {object} patch key→nilai
   * @returns {object} record service terbaru
   */
  updateConfig(serviceId, patch = {}) {
    const rec = this.getService(serviceId); // NOT_FOUND guard
    const clean = {};
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v !== null && v !== undefined) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) return rec;
    const merged = { ...(rec.config ?? {}), ...clean };
    const newPort = Number.isInteger(Number(clean.port)) && Number(clean.port) > 0 ? Number(clean.port) : null;
    const now = nowIso();
    this.store.tx(() => {
      if (newPort && newPort !== rec.port) {
        this.store.db
          .prepare('UPDATE services SET port = ?, config = ?, updated_at = ? WHERE id = ?')
          .run(newPort, JSON.stringify(merged), now, serviceId);
        this.store.db.prepare('DELETE FROM ports WHERE service_id = ?').run(serviceId);
        this.store.db
          .prepare(
            `INSERT INTO ports (port, service_id, bound_host, bound_at)
             VALUES (?, ?, '127.0.0.1', ?)
             ON CONFLICT(port) DO UPDATE SET service_id = excluded.service_id, bound_at = excluded.bound_at`,
          )
          .run(newPort, serviceId, now);
      } else {
        this.store.db
          .prepare('UPDATE services SET config = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(merged), now, serviceId);
      }
    });
    return this.getService(serviceId);
  }

  /** service-like object untuk adapter (kontrak adapter.startSpec). */
  _serviceLike(rec) {
    return {
      id: rec.id,
      name: rec.name,
      workspacePath: rec.config?.rootDir ?? this._projectWorkspacePath(rec.projectId) ?? null,
      port: rec.port,
      config: { ...(rec.config ?? {}) },
    };
  }

  _resolveAdapter(rec, serviceLike) {
    if (!rec.type || !(rec.type in this.adapters)) {
      throw new VmPanelError(VALIDATION, `tipe adapter tidak dikenal: ${String(rec.type)}`, {
        serviceId: rec.id,
        type: rec.type ?? null,
      });
    }
    // createAdapter memakai registry default; injected adapters map dipakai bila beda.
    if (this.adapters === ADAPTERS) {
      return createAdapter(rec.type, {
        workspacePath: serviceLike.workspacePath,
        config: serviceLike.config,
      });
    }
    return new this.adapters[rec.type]({
      workspacePath: serviceLike.workspacePath,
      config: serviceLike.config,
    });
  }

  /**
   * Start service. Status wajib stopped/failed (else VALIDATION 'bad state').
   * portBindTest dulu → false → PORT_IN_USE. Setelah spawn: upsert
   * supervisor_state (running, restart_count 0), UPDATE services
   * status 'running' + pid + started_at, re-claim ports row.
   * @returns {Promise<{serviceId: string, pid: number, port: number}>}
   */
  async startService(serviceId) {
    const rec = this.getService(serviceId);
    if (rec.status !== 'stopped' && rec.status !== 'failed') {
      throw new VmPanelError(
        VALIDATION,
        `bad state untuk start: '${rec.status}' (harus stopped/failed)`,
        { serviceId, status: rec.status },
      );
    }

    const serviceLike = this._serviceLike(rec);
    let canBind = await this.processManager.portBindTest(rec.port);
    if (!canBind) {
      // Tunggu sebentar (250ms) mengantisipasi socket TIME_WAIT di Windows setelah stop cepat
      await new Promise((r) => setTimeout(r, 250));
      canBind = await this.processManager.portBindTest(rec.port);
    }
    if (!canBind) {
      throw new VmPanelError(PORT_IN_USE, `port sudah terpakai: ${rec.port}`, {
        serviceId,
        port: rec.port,
      });
    }

    const adapter = this._resolveAdapter(rec, serviceLike);
    const spec = adapter.startSpec(serviceLike);

    const { pid, startTimeHint } = this.processManager.startProcess({
      serviceId,
      argv: spec.argv,
      cwd: spec.cwd,
      env: spec.env ?? {},
      extraEnv: {},
      // #32 — port ikut dilaporkan ke ProcessManager supaya exit-handler bisa
      // mengenali pola "gagal segera karena port sudah dipegang pihak lain".
      port: rec.port ?? null,
    });

    const now = nowIso();
    this.store.tx(() => {
      this.setSupervisorState(serviceId, {
        state: 'running',
        restartCount: 0,
        consecutiveFailures: 0,
        crashLoop: false,
        lastEvent: 'started',
      });
      this.store.db
        .prepare(
          `UPDATE services SET status = 'running', pid = ?, start_time_hint = ?, started_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(pid, startTimeHint ?? null, now, now, serviceId);
      this.store.db
        .prepare(
          `INSERT INTO ports (port, service_id, bound_host, bound_at)
           VALUES (?, ?, '127.0.0.1', ?)
           ON CONFLICT(port) DO NOTHING`,
        )
        .run(rec.port, serviceId, now);
    });

    this._audit('startService', { serviceId, pid, port: rec.port });
    return { serviceId, pid, port: rec.port };
  }

  /**
   * Stop service: processManager.stopProcess; status 'stopped', pid NULL;
   * supervisor_state 'stopped_by_user'; ports row dihapus (releasePort).
   */
  async stopService(serviceId, { graceMs = 10000 } = {}) {
    const rec = this.getService(serviceId);
    // #30 — bawa creation-time yang tercatat supaya ProcessManager bisa menolak
    // membunuh proses asing bila PID row ini sudah di-reuse.
    const killRes = await this.processManager.stopProcess({
      serviceId,
      graceMs,
      startTimeHint: rec.startTimeHint ?? null,
    });

    if (killRes && killRes.stopped === false) {
      // PID bukan anak kita lagi — setStatus/releasePort punya tx sendiri.
      this.setStatus(serviceId, 'failed', { pid: null, lastEvent: 'pid_reuse' });
      try {
        this.releasePort(serviceId);
      } catch {
        /* ports row mungkin sudah hilang */
      }
      this._audit('stopService.pid_reuse', {
        actor: 'system',
        serviceId,
        projectId: rec.projectId ?? null,
        input: { pid: killRes.pid ?? null, reason: killRes.reason ?? 'pid_reuse' },
        result: 'ok',
      });
      return { serviceId, status: 'failed', pidReuse: true };
    }
    const now = nowIso();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE services SET status = 'stopped', pid = NULL, start_time_hint = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, serviceId);
      this.setSupervisorState(serviceId, {
        state: 'stopped_by_user',
        lastEvent: 'stopped_by_user',
      });
      this.releasePort(serviceId);
    });

    void rec;
    this._audit('stopService', { serviceId });
    return { serviceId, status: 'stopped' };
  }

  /**
   * Restart = stop + start (status failed boleh restart; stopped cukup start).
   * @returns {Promise<{serviceId: string, pid: number, port: number}>}
   */
  async restartService(serviceId, { graceMs = 10000 } = {}) {
    const rec = this.getService(serviceId);
    if (rec.status === 'running') {
      await this.stopService(serviceId, { graceMs });
    } else if (rec.status !== 'failed' && rec.status !== 'stopped') {
      throw new VmPanelError(VALIDATION, `bad state untuk restart: '${rec.status}'`, {
        serviceId,
        status: rec.status,
      });
    }
    return this.startService(serviceId);
  }

  /**
   * Health check: resolve spec dari adapter (fallback service config.healthCheck)
   * → healthManager.runCheck + recordCheck → return hasil.
   */
  async healthService(serviceId, healthManager) {
    const rec = this.getService(serviceId);
    if (!healthManager || typeof healthManager.runCheck !== 'function') {
      throw new VmPanelError(VALIDATION, 'healthManager.runCheck wajib tersedia', { serviceId });
    }
    const serviceLike = this._serviceLike(rec);

    let check = null;
    try {
      const adapter = this._resolveAdapter(rec, serviceLike);
      check = adapter.healthCheckSpec(serviceLike);
    } catch {
      check = null; // fallback ke config service
    }
    if (!check) check = rec.config?.healthCheck ?? null;
    if (!check) {
      throw new VmPanelError(VALIDATION, 'tidak ada healthCheckSpec / config.healthCheck', {
        serviceId,
      });
    }

    if (check.type === 'process' && !check.pid) {
      check = { ...check, pid: rec.pid || 0 };
    }

    const outcome = await healthManager.runCheck({
      serviceId,
      projectId: rec.projectId,
      check,
    });
    if (typeof healthManager.recordCheck === 'function') {
      try {
        healthManager.recordCheck({ serviceId, projectId: rec.projectId, check, outcome });
      } catch {
        /* record gagal tidak boleh menggagalkan check */
      }
    }
    return outcome;
  }

  /**
   * Helper untuk supervisor lane: upsert service_supervisor_state.
   * @param {{state?: string, restartCount?: number, backoffUntil?: string|null,
   *   crashLoop?: boolean, consecutiveFailures?: number, lastEvent?: string}} patch
   */
  setSupervisorState(serviceId, patch = {}) {
    if (!isValidId(serviceId, 'svc_')) {
      throw new VmPanelError(VALIDATION, `format service id tidak valid: ${String(serviceId)}`, {
        serviceId,
      });
    }
    const existing = this.store.db
      .prepare('SELECT * FROM service_supervisor_state WHERE service_id = ?')
      .get(serviceId);
    const now = nowIso();
    const row = {
      state: patch.state ?? existing?.state ?? 'unknown',
      restart_count: patch.restartCount ?? existing?.restart_count ?? 0,
      backoff_until: patch.backoffUntil !== undefined
        ? (patch.backoffUntil != null ? String(patch.backoffUntil) : null)
        : (existing?.backoff_until ?? null),
      crash_loop: patch.crashLoop !== undefined ? (patch.crashLoop ? 1 : 0) : (existing?.crash_loop ?? 0),
      consecutive_failures: patch.consecutiveFailures ?? existing?.consecutive_failures ?? 0,
      last_event: patch.lastEvent ?? patch.state ?? existing?.last_event ?? 'unknown',
      updated_at: now,
    };
    this.store.db
      .prepare(
        `INSERT INTO service_supervisor_state
           (service_id, state, restart_count, backoff_until, crash_loop,
            consecutive_failures, last_event, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service_id) DO UPDATE SET
           state = excluded.state,
           restart_count = excluded.restart_count,
           backoff_until = excluded.backoff_until,
           crash_loop = excluded.crash_loop,
           consecutive_failures = excluded.consecutive_failures,
           last_event = excluded.last_event,
           updated_at = excluded.updated_at`,
      )
      .run(
        serviceId,
        row.state,
        row.restart_count,
        row.backoff_until,
        row.crash_loop,
        row.consecutive_failures,
        row.last_event,
        row.updated_at,
      );
    return this.getSupervisorState(serviceId);
  }

  getSupervisorState(serviceId) {
    if (!isValidId(serviceId, 'svc_')) {
      throw new VmPanelError(VALIDATION, `format service id tidak valid: ${String(serviceId)}`, {
        serviceId,
      });
    }
    const row = this.store.db
      .prepare('SELECT * FROM service_supervisor_state WHERE service_id = ?')
      .get(serviceId);
    if (!row) return null;
    return {
      serviceId: row.service_id,
      state: row.state,
      restartCount: row.restart_count,
      backoffUntil: row.backoff_until,
      crashLoop: row.crash_loop === 1,
      consecutiveFailures: row.consecutive_failures,
      lastEvent: row.last_event,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Transisi status service eksplisit (#31b). HANYA mengubah baris `services`
   * (+ sinkron state supervisor) — TIDAK pernah menyentuh proses OS, jadi
   * aman dipakai rekonsiliasi baris yatim saat start.
   * @param {string} serviceId
   * @param {'stopped'|'running'|'failed'|'disabled'} status
   * @param {{pid?: number|null, lastEvent?: string|null}} [patch]
   *   `pid` tidak diberikan → kolom pid dibiarkan apa adanya; `null` → dikosongkan.
   */
  setStatus(serviceId, status, { pid = undefined, lastEvent = null } = {}) {
    if (!SERVICE_STATUSES.has(status)) {
      throw new VmPanelError(VALIDATION, `status service tidak dikenal: ${String(status)}`, {
        serviceId,
        status,
        allowed: [...SERVICE_STATUSES],
      });
    }
    const rec = this.getService(serviceId); // NOT_FOUND + format guard
    const now = nowIso();
    const cols = ['status = ?', 'updated_at = ?'];
    const vals = [status, now];
    if (pid !== undefined) {
      cols.push('pid = ?');
      vals.push(pid == null ? null : Number(pid));
    }
    if (status !== 'running') {
      // #30 — hint creation-time hanya bermakna untuk baris yang benar-benar
      // berjalan; baris mati/failed wajib bersih agar tidak pernah false-match
      // ke proses lain yang kebetulan dapat PID yang sama.
      cols.push('start_time_hint = NULL');
    }
    this.store.tx(() => {
      this.store.db
        .prepare(`UPDATE services SET ${cols.join(', ')} WHERE id = ?`)
        .run(...vals, serviceId);
      this.setSupervisorState(serviceId, {
        state: status,
        lastEvent: lastEvent ?? `status:${status}`,
      });
    });
    return this.getService(serviceId) ?? rec;
  }

  /**
   * #31b — Rekonsiliasi baris `running` yatim saat manager start (SEBELUM
   * supervisor auto-start). Manager crash/restart meninggalkan baris status
   * 'running' padahal prosesnya sudah mati → auto-start supervisor akan
   * menganggapnya hidup sampai tick pertama.
   *
   * Aturan:
   *  - PID mati / tidak ada → setStatus('failed', pid: null) + audit event
   *    `service.reconciled_dead`. TIDAK ada kill proses, TIDAK ada hapus
   *    ports row (masih bisa di-bind ulang / dipakai proses yatim).
   *  - PID hidup tapi TIDAK dikenal registry ProcessManager proses ini
   *    (proses yatim dari daemon lama) → DIBIARKAN + log warning.
   *  - PID hidup dan dikenal → dibiarkan (supervisor lanjut mengawasi).
   * @returns {Promise<{checked: number, reconciled: object[], orphans: object[]}>}
   */
  async reconcileStaleRunning() {
    const rows = this.store.db
      .prepare(`SELECT * FROM services WHERE status = 'running'`)
      .all();
    const knownPids = new Map();
    try {
      for (const p of this.processManager?.listProcesses?.() ?? []) {
        if (Number.isInteger(p.pid)) knownPids.set(p.serviceId, p.pid);
      }
    } catch {
      /* processManager tanpa listProcesses → dianggap tidak ada yang dikenal */
    }
    const reconciled = [];
    const orphans = [];
    for (const row of rows) {
      const pid = Number.isInteger(row.pid) && row.pid > 0 ? row.pid : null;
      const hint = Number.isInteger(row.start_time_hint) ? row.start_time_hint : null;
      let alive = false;
      if (pid != null) {
        try {
          alive = (await this.processManager.isAlive(pid, hint)) === true;
        } catch (e) {
          this.logger.warn('service.reconcile.isalive_error', {
            serviceId: row.id,
            pid,
            reason: String(e?.message ?? e),
          });
          alive = false;
        }
      }
      if (alive) {
        if (knownPids.get(row.id) !== pid) {
          orphans.push({ serviceId: row.id, pid });
          this.logger.warn('service.reconcile.orphan_alive', {
            serviceId: row.id,
            pid,
            hint,
            note: 'PID hidup tapi tidak dikenal proses manager ini — dibiarkan, tidak di-kill',
          });
        }
        continue;
      }
      // Mati (atau PID hilang) → tandai failed. Tidak pernah kill, tidak
      // pernah hapus ports row.
      try {
        this.setStatus(row.id, 'failed', {
          pid: null,
          lastEvent: 'reconciled_dead',
        });
      } catch (e) {
        this.logger.warn('service.reconcile.setStatus_failed', {
          serviceId: row.id,
          reason: String(e?.message ?? e),
        });
        continue;
      }
      reconciled.push({ serviceId: row.id, pid, port: row.port ?? null });
      this._audit('service.reconciled_dead', {
        actor: 'system',
        serviceId: row.id,
        projectId: row.project_id ?? null,
        port: row.port ?? null,
        statusBefore: 'running',
        statusAfter: 'failed',
        result: 'ok',
        input: {
          pid,
          start_time_hint: hint,
          reason: pid == null ? 'pid_missing' : 'pid_not_alive',
        },
      });
      this.logger.warn('service.reconciled_dead', { serviceId: row.id, pid, port: row.port ?? null });
    }
    if (reconciled.length > 0 || orphans.length > 0) {
      this.logger.info('service.reconcile.summary', {
        checked: rows.length,
        reconciled: reconciled.length,
        orphanAlive: orphans.length,
      });
    }
    return { checked: rows.length, reconciled, orphans };
  }

  /** enable: enabled=1, status kembali 'stopped'. */
  enable(serviceId) {
    const rec = this.getService(serviceId);
    if (rec.status !== 'disabled') {
      throw new VmPanelError(VALIDATION, `enable butuh status disabled (sekarang: ${rec.status})`, {
        serviceId,
        status: rec.status,
      });
    }
    this.store.db
      .prepare(`UPDATE services SET enabled = 1, status = 'stopped', updated_at = ? WHERE id = ?`)
      .run(nowIso(), serviceId);
    return this.getService(serviceId);
  }

  /** disable: enabled=0, status 'disabled' (service running akan distop dulu). */
  async disable(serviceId, { graceMs = 10000 } = {}) {
    const rec = this.getService(serviceId);
    if (rec.status === 'running') {
      await this.stopService(serviceId, { graceMs });
    }
    this.store.db
      .prepare(`UPDATE services SET enabled = 0, status = 'disabled', updated_at = ? WHERE id = ?`)
      .run(nowIso(), serviceId);
    this._audit('disableService', { serviceId });
    return this.getService(serviceId);
  }

  /** Hapus ports row milik serviceId (dipanggil saat stop/remove). */
  releasePort(serviceId) {
    this.getService(serviceId); // NOT_FOUND guard
    this.store.db.prepare('DELETE FROM ports WHERE service_id = ?').run(serviceId);
    return { serviceId };
  }

  _audit(operation, fields = {}) {
    if (!this.auditManager || typeof this.auditManager.append !== 'function') return;
    try {
      this.auditManager.append({ operation, ...fields, at: nowIso() });
    } catch {
      /* audit failure tidak boleh menggagalkan operasi utama */
    }
  }

  close() {
    this.store.close();
    if (this._projectsRo) {
      try {
        this._projectsRo.close();
      } catch {
        /* sudah tertutup */
      }
    }
  }
}

export default ServiceManager;
