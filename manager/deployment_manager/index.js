// manager/deployment_manager/index.js — DeploymentManager (docs/DESIGN.md §3.2, §7, §7.3).
// deployments.db via lib/db.js openDatabase({schemaName:'deployments'}) — tabel
// deployments, deployment_events, revisions; DDL dari lib/schema.js (tidak
// ditulis ulang, TIDAK ada ALTER TABLE).
//
// State machine deploy (§7): validating → preparing → installing → configuring
// → switching → starting → verifying → success|failed. Setiap stage menulis
// deployment_events (status ok/fail, detail clamp 2KB + redact).
//
// Isolasi kegagalan (§7.3): gagal di stage mana pun TIDAK menyentuh service
// lama (state terakhir dibiarkan); stage 'fetching' (git) gagal sebelum
// switching apa pun. Auto-rollback deployment disconnected (§7.3) via
// sweepDisconnected → RollbackManager.
//
// Kontrak service: satu service per project — dibuat sekali saat switching
// (serviceManager.createService, config {rootDir: workspacePath}); deploy
// berikutnya stop→start ulang dengan workspace/revision baru.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

import { openDatabase } from '../../lib/db.js';
import { genId, isValidId } from '../../lib/ids.js';
import {
  VmPanelError,
  VALIDATION,
  NOT_FOUND,
  DEPLOY_IN_PROGRESS,
} from '../../lib/errors.js';
import { withLock } from '../../lib/lock.js';
import { makeRedactor } from '../../lib/redact.js';
import { ADAPTERS, createAdapter } from '../adapters/index.js';
import { RollbackManager } from '../rollback_manager/index.js';

const LOCK_WAIT_MS = 3000; // §3.2: lock per-project, tunggu maks 3 detik
const LOCK_TTL_MS = 300_000; // ttl cukup untuk deploy panjang (git 120s)
const GIT_TIMEOUT_MS = 120_000; // clone/rev-parse timeout 120s
const EVENT_DETAIL_MAX = 2048; // detail event di-clamp 2KB
const HEALTH_RETRIES = 5; // verifying: max 5 percobaan
const HEALTH_RETRY_MS = 400;
const SWEEP_DEFAULT_OLDER_MS = 600_000; // §7.3: disconnected > 10 menit
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 1000;

const DEPLOY_STAGES = Object.freeze([
  'validating',
  'preparing',
  'installing',
  'configuring',
  'switching',
  'starting',
  'verifying',
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e) {
  if (e && typeof e.message === 'string' && e.message.length > 0) return e.message;
  return String(e);
}

function clamp2k(s) {
  return s.length > EVENT_DETAIL_MAX ? s.slice(0, EVENT_DETAIL_MAX) : s;
}

function isNotImplemented(e) {
  return !!e && e.code === VALIDATION && /not implemented/i.test(errMsg(e));
}

/** execFile yang di-promise (NO SHELL, argv murni). */
function execFileP(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, shell: false, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Hash konten workspace: walk rekursif file (nama file relatif + isi),
 * sha256 → 8 char hex. Stabil untuk konten identik.
 */
function hashWorkspace(wsPath) {
  const hash = createHash('sha256');
  const stack = [wsPath];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        hash.update(path.relative(wsPath, full).replaceAll('\\', '/'));
        hash.update('\0');
        try {
          hash.update(fs.readFileSync(full));
        } catch {
          /* file tidak terbaca — skip isinya */
        }
        hash.update('\0');
      }
    }
  }
  return hash.digest('hex').slice(0, 8);
}

/**
 * DeploymentManager — pipeline deploy per project: lock, stage machine,
 * event trail, revisions marker, dan auto-rollback disconnected.
 */
export class DeploymentManager {
  /**
   * @param {{
   *   dataDir: string,
   *   serviceManager: object,
   *   projectManager?: object|null,
   *   healthManager?: object|null,
   *   adapters?: typeof ADAPTERS,
   *   lockDir?: string,
   *   gitBin?: string,
   *   nowFn?: () => Date|number|string,
   *   sleepFn?: (ms: number) => Promise<void>,
   *   rollbackManager?: object|null,
   * }} opts
   */
  constructor({
    dataDir,
    serviceManager,
    projectManager = null,
    healthManager = null,
    adapters = ADAPTERS,
    lockDir = null,
    gitBin = 'git',
    nowFn = null,
    sleepFn = null,
    rollbackManager = null,
  }) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'DeploymentManager: dataDir wajib');
    }
    if (!serviceManager || typeof serviceManager.createService !== 'function') {
      throw new VmPanelError(VALIDATION, 'DeploymentManager: serviceManager wajib');
    }
    this.dataDir = path.resolve(dataDir);
    this.serviceManager = serviceManager;
    this.projectManager = projectManager;
    this.healthManager = healthManager;
    this.adapters = adapters;
    this.gitBin = gitBin;
    this.rollbackManager = rollbackManager; // opsional; lazy dibuat oleh sweep
    this._ownsRollbackManager = false;
    this._nowFn = nowFn ?? (() => new Date());
    this._sleep = sleepFn ?? sleep;
    this._lockDir = lockDir ?? path.join(this.dataDir, 'locks');
    this._redact = makeRedactor();
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this._lockDir, { recursive: true });
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

  /** INSERT deployment_events (detail direduksi + clamp 2KB). */
  _event(deploymentId, stage, status, detail) {
    this.store.db
      .prepare(
        `INSERT INTO deployment_events (deployment_id, stage, status, detail, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        deploymentId,
        stage,
        status,
        detail == null ? null : clamp2k(this._redact(String(detail))),
        this._iso(),
      );
  }

  /** UPDATE deployments.stage (progress state machine). */
  _setStage(deploymentId, stage) {
    this.store.db.prepare('UPDATE deployments SET stage = ? WHERE id = ?').run(stage, deploymentId);
  }

  /** Finalisasi deployment gagal: status failed + stage + error sanitized. */
  _fail(deploymentId, stage, e) {
    const error = this._sanitize(e);
    this._setStage(deploymentId, stage);
    this._event(deploymentId, stage, 'fail', error);
    this.store.db
      .prepare('UPDATE deployments SET status = ?, error = ?, finished_at = ? WHERE id = ?')
      .run('failed', error, this._iso(), deploymentId);
    return { deploymentId, status: 'failed', stage, error };
  }

  /** Project wajib ada (NOT_FOUND tanpa deployment row). */
  _getProject(projectId) {
    if (!this.projectManager || typeof this.projectManager.getProject !== 'function') {
      throw new VmPanelError(
        VALIDATION,
        'DeploymentManager: projectManager wajib untuk validasi project',
        { projectId },
      );
    }
    return this.projectManager.getProject(projectId);
  }

  /**
   * deploy({projectId, source, actor}) → {deploymentId, status, revision}.
   * withLock('deploy-<projectId>', maxWait 3s) → LOCK_HELD → DEPLOY_IN_PROGRESS.
   */
  async deploy({ projectId, source = { type: 'workspace' }, actor = null } = {}) {
    if (!isValidId(projectId, 'prj_')) {
      throw new VmPanelError(VALIDATION, `format projectId tidak valid: ${String(projectId)}`, {
        projectId,
      });
    }
    try {
      return await withLock(
        `deploy-${projectId}`,
        { dir: this._lockDir, ttlMs: LOCK_TTL_MS, maxWaitMs: LOCK_WAIT_MS },
        () => this._runDeploy({ projectId, source: source ?? { type: 'workspace' }, actor }),
      );
    } catch (e) {
      if (e && e.code === 'LOCK_HELD') {
        throw new VmPanelError(DEPLOY_IN_PROGRESS, 'deployment sedang berjalan untuk project ini', {
          projectId,
        });
      }
      throw e;
    }
  }

  async _runDeploy({ projectId, source, actor }) {
    // (2) Project wajib ada sebelum row dibuat; INSERT deployments status running.
    const project = this._getProject(projectId);
    if (source.type === 'git' && (typeof source.url !== 'string' || source.url.length === 0)) {
      throw new VmPanelError(VALIDATION, 'source git: url wajib string', { url: source.url ?? null });
    }

    const deploymentId = genId('dep_');
    this.store.db
      .prepare(
        `INSERT INTO deployments
           (id, project_id, revision, actor, status, stage, error, started_at, finished_at, rollback_of)
         VALUES (?, ?, NULL, ?, 'running', 'validating', NULL, ?, NULL, NULL)`,
      )
      .run(deploymentId, projectId, actor ?? 'system', this._iso());

    try {
      // (3) SOURCE: workspace → 'ws-' + sha256 konten; git → clone + rev-parse.
      let revision = null;
      let rootDir = project.workspacePath;
      if (source.type === 'git') {
        this._setStage(deploymentId, 'fetching');
        try {
          const targetDir = path.join(this.dataDir, 'git-sources', `git-${genId('dep')}-${Date.now()}`);
          fs.mkdirSync(targetDir, { recursive: true });
          try {
            await execFileP(
              this.gitBin,
              [
                'clone',
                '--depth',
                String(source.depth ?? 1),
                '--branch',
                source.branch ?? 'main',
                source.url,
                targetDir,
              ],
              { timeout: GIT_TIMEOUT_MS },
            );
            const { stdout } = await execFileP(this.gitBin, ['rev-parse', 'HEAD'], {
              cwd: targetDir,
              timeout: GIT_TIMEOUT_MS,
            });
            revision = String(stdout).trim().slice(0, 8);
          } catch (e) {
            try {
              fs.rmSync(path.dirname(targetDir) === this.dataDir ? targetDir : targetDir, {
                recursive: true,
                force: true,
              });
            } catch {
              /* best-effort */
            }
            throw new VmPanelError(VALIDATION, `git clone gagal: ${this._sanitize(e)}`, {
              url: source.url,
              branch: source.branch ?? 'main',
            });
          }
          rootDir = targetDir;
          this._event(deploymentId, 'fetching', 'ok', `revision ${revision} di ${path.basename(targetDir)}`);
        } catch (e) {
          return this._fail(deploymentId, 'fetching', e);
        }
      } else {
        revision = 'ws-' + hashWorkspace(project.workspacePath);
      }

      this.store.db
        .prepare('UPDATE deployments SET revision = ? WHERE id = ?')
        .run(revision, deploymentId);

      // (4a) Service kontrak: dibuat sekali per project; config rootDir permanen.
      let service;
      try {
        service = this._resolveServiceForDeploy(project, rootDir);
      } catch (e) {
        return this._fail(deploymentId, 'switching', e);
      }

      // (4b) STAGES bertahap, try/catch per stage (§7.3).
      const stageFns = [
        ['validating', () => this._stageValidating(service)],
        ['preparing', () => this._stageAdapterStep(service, 'prepare')],
        ['installing', () => this._stageAdapterStep(service, 'install')],
        ['configuring', () => this._stageAdapterStep(service, 'configure')],
        ['switching', () => this._stageSwitching(service)],
        ['starting', () => this._stageStarting(service)],
        ['verifying', () => this._stageVerifying(service)],
      ];
      for (const [stage, fn] of stageFns) {
        this._setStage(deploymentId, stage);
        try {
          const note = await fn();
          this._event(deploymentId, stage, 'ok', note ?? null);
        } catch (e) {
          return this._fail(deploymentId, stage, e);
        }
      }

      // (5) Verifying lulus → revisions marker 'success' + finished_at.
      const at = this._iso();
      this.store.tx(() => {
        this.store.db
          .prepare(
            `INSERT INTO revisions (project_id, revision, source, marker, at)
             VALUES (?, ?, ?, 'success', ?)
             ON CONFLICT(project_id, revision)
             DO UPDATE SET marker = 'success', source = excluded.source, at = excluded.at`,
          )
          .run(projectId, revision, source.type, at);
        this.store.db
          .prepare(`UPDATE deployments SET status = 'success', finished_at = ? WHERE id = ?`)
          .run(at, deploymentId);
      });
      return { deploymentId, status: 'success', revision };
    } catch (e) {
      // Safety net — seharusnya tertangkap per-stage.
      return this._fail(deploymentId, 'validating', e);
    }
  }

  /**
   * Service untuk deploy: existing (listServices project) dipakai ulang;
   * belum ada → createService (config {rootDir}). Port dari project.port.
   */
  _resolveServiceForDeploy(project, rootDir) {
    const existing = this.serviceManager.listServices({ projectId: project.id });
    if (existing && existing.length > 0) return existing[0];
    if (!Number.isInteger(project.port)) {
      throw new VmPanelError(
        VALIDATION,
        'port project wajib untuk membuat service (set project.port)',
        { projectId: project.id },
      );
    }
    const name = `svc-${project.name}`.slice(0, 63);
    return this.serviceManager.createService({
      projectId: project.id,
      name,
      type: project.type,
      port: project.port,
      config: { rootDir },
    });
  }

  _adapterFor(service) {
    return createAdapter(service.type, {
      workspacePath: service.rootDir ?? service.config?.rootDir ?? null,
      config: { ...(service.config ?? {}), port: service.port },
    });
  }

  _stageValidating(service) {
    const adapter = this._adapterFor(service);
    try {
      return adapter.validate({ port: service.port });
    } catch (e) {
      if (isNotImplemented(e)) {
        return { ok: true, note: 'adapter validate not implemented — minimal check' };
      }
      throw e;
    }
  }

  /**
   * prepare/install/configure: adapter mungkin tidak implement (BaseAdapter
   * throw VALIDATION 'not implemented') → skip sebagai ok-dengan-note.
   */
  async _stageAdapterStep(service, method) {
    const adapter = this._adapterFor(service);
    const fn = adapter[method];
    if (typeof fn !== 'function') return { ok: true, note: `${method} tidak tersedia — skip` };
    try {
      const res = await fn.call(adapter, {
        workspacePath: service.rootDir ?? service.config?.rootDir ?? null,
        port: service.port,
      });
      return res ?? { ok: true };
    } catch (e) {
      if (isNotImplemented(e)) {
        return { ok: true, note: `${method} not implemented — skip` };
      }
      throw e;
    }
  }

  /** switching: service running → stop (start lagi di stage starting). */
  async _stageSwitching(service) {
    const rec = this.serviceManager.getService(service.id);
    if (rec.status === 'running') {
      await this.serviceManager.stopService(rec.id);
      return 'service lama di-stop untuk switch revision baru';
    }
    return `service status '${rec.status}' — langsung start`;
  }

  async _stageStarting(service) {
    const rec = this.serviceManager.getService(service.id);
    if (rec.status === 'running') return 'service sudah running';
    const started = await this.serviceManager.startService(rec.id);
    return `service started pid ${started.pid} port ${started.port}`;
  }

  /** verifying: healthService retry max 5 x 400ms (sleep injectable). */
  async _stageVerifying(service) {
    let lastErr = null;
    for (let attempt = 1; attempt <= HEALTH_RETRIES; attempt++) {
      try {
        const outcome = await this.serviceManager.healthService(service.id, this.healthManager);
        if (outcome && outcome.ok === true) {
          return `health ok (attempt ${attempt}, latency ${outcome.latencyMs ?? '?'}ms)`;
        }
        lastErr = new Error(outcome?.error ?? 'health check tidak ok');
      } catch (e) {
        lastErr = e;
      }
      if (attempt < HEALTH_RETRIES) await this._sleep(HEALTH_RETRY_MS);
    }
    throw lastErr ?? new Error('health check gagal setelah retry');
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** Row deployment + events (urut id ASC). NOT_FOUND bila tidak ada. */
  getDeployment(id) {
    const row = this.store.db.prepare('SELECT * FROM deployments WHERE id = ?').get(String(id));
    if (!row) {
      throw new VmPanelError(NOT_FOUND, `deployment tidak ditemukan: ${id}`, { id });
    }
    const events = this.store.db
      .prepare('SELECT * FROM deployment_events WHERE deployment_id = ? ORDER BY id ASC')
      .all(row.id);
    return { ...row, events };
  }

  /** listDeployments({projectId, status, limit}) — terbaru dulu. */
  listDeployments({ projectId = null, status = null, limit = LIST_LIMIT_DEFAULT } = {}) {
    const where = [];
    const params = [];
    if (projectId != null) {
      where.push('project_id = ?');
      params.push(String(projectId));
    }
    if (status != null) {
      where.push('status = ?');
      params.push(String(status));
    }
    const lim = Math.min(
      Math.max(Number.isInteger(limit) && limit > 0 ? limit : LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
    const sql = `SELECT * FROM deployments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`;
    return this.store.db.prepare(sql).all(...params, lim);
  }

  // ── sweep disconnected (§7.3) ──────────────────────────────────────────────

  _ensureRollbackManager() {
    if (!this.rollbackManager) {
      this.rollbackManager = new RollbackManager({
        dataDir: this.dataDir,
        serviceManager: this.serviceManager,
        healthManager: this.healthManager,
        nowFn: this._nowFn,
        sleepFn: this._sleep,
      });
      this._ownsRollbackManager = true;
    }
    return this.rollbackManager;
  }

  /**
   * sweepDisconnected({olderThanMs=600000}): deployment 'running' dengan
   * started_at lebih tua dari threshold → status 'failed', stage
   * 'disconnected' + auto-rollback (§7.3). Return list yang di-rollback.
   */
  async sweepDisconnected({ olderThanMs = SWEEP_DEFAULT_OLDER_MS } = {}) {
    const ms = Number(olderThanMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new VmPanelError(VALIDATION, 'olderThanMs wajib angka > 0', { olderThanMs });
    }
    const cutoff = new Date(this._now().getTime() - ms).toISOString();
    const stale = this.store.db
      .prepare(`SELECT * FROM deployments WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`)
      .all(cutoff);

    const rolledBack = [];
    for (const row of stale) {
      this.store.db
        .prepare(
          `UPDATE deployments SET status = 'failed', stage = 'disconnected', error = ?, finished_at = ? WHERE id = ?`,
        )
        .run('deployment disconnected (marker success tidak ter-set)', this._iso(), row.id);
      this._event(row.id, 'disconnected', 'fail', 'deployment terputus — auto-rollback §7.3');

      let rollback = null;
      try {
        const rm = this._ensureRollbackManager();
        rollback = await rm.rollback({ projectId: row.project_id, actor: 'system:auto-rollback' });
        this._event(row.id, 'disconnected', 'ok', `auto-rollback sukses → ${rollback.to}`);
      } catch (e) {
        // Tidak ada revision sukses / service hilang — catat, jangan crash.
        this._event(row.id, 'disconnected', 'fail', `auto-rollback gagal: ${this._sanitize(e)}`);
        rollback = { error: this._sanitize(e) };
      }
      rolledBack.push({ deploymentId: row.id, projectId: row.project_id, rollback });
    }
    return rolledBack;
  }

  close() {
    if (this.rollbackManager && this._ownsRollbackManager) {
      try {
        this.rollbackManager.close();
      } catch {
        /* sudah tertutup */
      }
    }
    this.store.close();
  }
}

export default DeploymentManager;
