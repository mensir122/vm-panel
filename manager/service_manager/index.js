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
   * }} opts
   */
  constructor({
    dataDir,
    processManager,
    adapters = ADAPTERS,
    auditManager = null,
    projectsDbPath = null,
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
    fs.mkdirSync(this.dataDir, { recursive: true });

    const opened = openDatabase(path.join(this.dataDir, 'services.db'), {
      schemaName: 'services',
    });
    this.store = opened;
    opened.migrate();

    // Ensure kolom `config` (aditif, idempotent — bukan penulisan ulang DDL).
    const cols = this.store.db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
    if (!cols.includes('config')) {
      this.store.db.exec('ALTER TABLE services ADD COLUMN config TEXT');
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
      this.processManager.setExitHandler((serviceId) => {
        try {
          this.releasePort(serviceId);
        } catch {
          /* DB sudah close / service row sudah dihapus — abaikan */
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
    // project (untuk static), healthCheck untuk health lane.
    const mergedConfig = {
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
    const canBind = await this.processManager.portBindTest(rec.port);
    if (!canBind) {
      throw new VmPanelError(PORT_IN_USE, `port sudah terpakai: ${rec.port}`, {
        serviceId,
        port: rec.port,
      });
    }

    const adapter = this._resolveAdapter(rec, serviceLike);
    const spec = adapter.startSpec(serviceLike);

    const { pid } = this.processManager.startProcess({
      serviceId,
      argv: spec.argv,
      cwd: spec.cwd,
      env: spec.env ?? {},
      extraEnv: {},
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
          `UPDATE services SET status = 'running', pid = ?, started_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(pid, now, now, serviceId);
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
    await this.processManager.stopProcess({ serviceId, graceMs });

    const now = nowIso();
    this.store.tx(() => {
      this.store.db
        .prepare(`UPDATE services SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?`)
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
      .prepare('SELECT restart_count FROM service_supervisor_state WHERE service_id = ?')
      .get(serviceId);
    const now = nowIso();
    const row = {
      state: patch.state ?? existing?.state ?? 'unknown',
      restart_count: patch.restartCount ?? existing?.restart_count ?? 0,
      backoff_until: patch.backoffUntil ?? null,
      crash_loop: (patch.crashLoop ? 1 : 0),
      consecutive_failures: patch.consecutiveFailures ?? 0,
      last_event: patch.lastEvent ?? patch.state ?? 'unknown',
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
