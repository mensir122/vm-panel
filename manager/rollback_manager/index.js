// manager/rollback_manager/index.js — RollbackManager (docs/DESIGN.md §7, §7.3).
// deployments.db via lib/db.js openDatabase({schemaName:'deployments'}); DDL
// dari lib/schema.js — TIDAK ada ALTER TABLE. Rollback tercatat sebagai row
// deployments dengan stage 'rolling-back' (tabel tidak punya kolom 'type').
// Revisions table: marker 'success' = revision terbukti sehat; rollback sukses
// menandai target 'rollback-target'.

import path from 'node:path';

import { openDatabase } from '../../lib/db.js';
import { genId } from '../../lib/ids.js';
import { VmPanelError, VALIDATION, NOT_FOUND } from '../../lib/errors.js';
import { makeRedactor } from '../../lib/redact.js';

const HEALTH_RETRIES = 3;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e) {
  if (e && typeof e.message === 'string' && e.message.length > 0) return e.message;
  return String(e);
}

function clamp2k(s) {
  return s.length > 2048 ? s.slice(0, 2048) : s;
}

/**
 * RollbackManager — revision pointer + rollback deployment + history.
 */
export class RollbackManager {
  /**
   * @param {{
   *   dataDir: string,
   *   serviceManager: import('../service_manager/index.js').ServiceManager,
   *   healthManager?: object|null,
   *   nowFn?: () => Date|number|string,
   *   sleepFn?: (ms: number) => Promise<void>,
   * }} opts
   */
  constructor({ dataDir, serviceManager, healthManager = null, nowFn = null, sleepFn = null }) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'RollbackManager: dataDir wajib');
    }
    if (!serviceManager || typeof serviceManager.createService !== 'function') {
      throw new VmPanelError(VALIDATION, 'RollbackManager: serviceManager wajib');
    }
    this.dataDir = dataDir;
    this.serviceManager = serviceManager;
    this.healthManager = healthManager;
    this._nowFn = nowFn ?? (() => new Date());
    this._sleep = sleepFn ?? sleep;
    this._redact = makeRedactor();
    const opened = openDatabase(path.join(this.dataDir, 'deployments.db'), {
      schemaName: 'deployments',
    });
    this.store = opened;
    opened.migrate();
  }

  _now() {
    const v = this._nowFn();
    return v instanceof Date ? v : new Date(v);
  }

  _iso() {
    return this._now().toISOString();
  }

  _sanitize(e) {
    return clamp2k(this._redact(errMsg(e)));
  }

  _event(deploymentId, stage, status, detail) {
    this.store.db
      .prepare(
        `INSERT INTO deployment_events (deployment_id, stage, status, detail, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(deploymentId, stage, status, detail == null ? null : clamp2k(this._redact(String(detail))), this._iso());
  }

  /**
   * Rollback project ke revision sukses (§7.3).
   * @param {{projectId: string, actor?: string, targetRevision?: string}} input
   * @returns {Promise<{deploymentId: string, status: string, from: string|null, to: string}>}
   */
  async rollback({ projectId, actor = null, targetRevision = null } = {}) {
    if (!projectId || typeof projectId !== 'string') {
      throw new VmPanelError(VALIDATION, 'rollback: projectId wajib', { projectId });
    }

    // (1) Baca revisions project yang pernah sukses, urut terbaru (at DESC).
    // Marker 'rollback-target' tetap jadi kandidat — revision hasil rollback
    // pernah sukses dan harus tetap bisa jadi target rollback berikutnya.
    const successes = this.store.db
      .prepare(
        `SELECT * FROM revisions WHERE project_id = ? AND marker IN ('success', 'rollback-target')
         ORDER BY at DESC, revision DESC`,
      )
      .all(projectId);

    if (!successes || successes.length === 0) {
      // (2) Tanpa revision sukses sama sekali → VALIDATION.
      throw new VmPanelError(VALIDATION, 'no successful revision to roll back to', { projectId });
    }

    // Revision saat ini = revision sukses terbaru (atau dari deployment sukses terakhir).
    const current = successes[0].revision;

    let target = null;
    if (targetRevision != null) {
      // targetRevision eksplisit wajib ada di revisions (marker success).
      const found = successes.find((r) => r.revision === targetRevision);
      if (!found) {
        throw new VmPanelError(
          NOT_FOUND,
          `targetRevision tidak ditemukan di revisions: ${targetRevision}`,
          { projectId, targetRevision },
        );
      }
      target = targetRevision;
    } else {
      // Default: sukses terakhir yang BUKAN revision saat ini.
      const candidate = successes.find((r) => r.revision !== current);
      if (!candidate) {
        throw new VmPanelError(
          VALIDATION,
          'no successful revision to roll back to (current is the only success)',
          { projectId, current },
        );
      }
      target = candidate.revision;
    }

    // (3) INSERT deployments (stage 'rolling-back' sebagai penanda type rollback).
    const deploymentId = genId('dep_');
    const startedAt = this._iso();
    this.store.db
      .prepare(
        `INSERT INTO deployments (id, project_id, revision, actor, status, stage, error, started_at, finished_at, rollback_of)
         VALUES (?, ?, ?, ?, 'running', 'rolling-back', NULL, ?, NULL, NULL)`,
      )
      .run(deploymentId, projectId, target, actor ?? 'system:rollback', startedAt);
    this._event(deploymentId, 'rolling-back', 'start', `rollback ${current ?? 'unknown'} -> ${target}`);

    try {
      // Restart service project (stop+start) dengan health verify retry 3.
      const services = this.serviceManager.listServices({ projectId });
      if (!services || services.length === 0) {
        throw new VmPanelError(NOT_FOUND, 'tidak ada service untuk project ini', { projectId });
      }
      const svc = services[0];
      if (svc.status === 'running') {
        await this.serviceManager.stopService(svc.id);
      }
      if (this.serviceManager.getService(svc.id).status !== 'running') {
        await this.serviceManager.startService(svc.id);
      }

      let lastErr = null;
      let ok = false;
      for (let attempt = 1; attempt <= HEALTH_RETRIES; attempt++) {
        try {
          const outcome = await this.serviceManager.healthService(svc.id, this.healthManager);
          if (outcome && outcome.ok === true) {
            ok = true;
            break;
          }
          lastErr = new Error(outcome?.error ?? 'health check tidak ok');
        } catch (e) {
          lastErr = e;
        }
        if (attempt < HEALTH_RETRIES) await this._sleep(400);
      }
      if (!ok) throw lastErr ?? new Error('health check gagal setelah retry');

      // Sukses: status success + revisions marker 'rollback-target'.
      const at = this._iso();
      this.store.tx(() => {
        this.store.db
          .prepare(
            `INSERT INTO revisions (project_id, revision, source, marker, at)
             VALUES (?, ?, 'rollback', 'rollback-target', ?)
             ON CONFLICT(project_id, revision) DO UPDATE SET marker = 'rollback-target', at = excluded.at`,
          )
          .run(projectId, target, at);
        this.store.db
          .prepare(`UPDATE deployments SET status = 'success', finished_at = ? WHERE id = ?`)
          .run(at, deploymentId);
      });
      this._event(deploymentId, 'rolling-back', 'ok', `rollback success revision ${target}`);
      return { deploymentId, from: current, to: target };
    } catch (e) {
      const error = this._sanitize(e);
      this._event(deploymentId, 'rolling-back', 'fail', error);
      this.store.db
        .prepare(`UPDATE deployments SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(error, this._iso(), deploymentId);
      throw new VmPanelError(VALIDATION, `rollback gagal: ${error}`, {
        deploymentId,
        projectId,
        target,
      });
    }
  }

  /**
   * Riwayat rollback project: deployments dengan stage 'rolling-back'
   * (tabel deployments tidak punya kolom type — stage adalah penandanya).
   */
  getRollbackHistory(projectId) {
    if (!projectId || typeof projectId !== 'string') {
      throw new VmPanelError(VALIDATION, 'getRollbackHistory: projectId wajib', { projectId });
    }
    return this.store.db
      .prepare(`SELECT * FROM deployments WHERE project_id = ? AND stage = 'rolling-back' ORDER BY started_at DESC, id DESC`)
      .all(projectId);
  }

  close() {
    this.store.close();
  }
}

export default RollbackManager;
