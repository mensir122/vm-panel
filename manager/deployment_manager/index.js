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
// (serviceManager.createService, config {type, rootDir, main, port,
// healthCheck}); deploy berikutnya stop→start ulang dengan workspace/revision
// baru (rootDir/main config service di-update saat re-deploy).

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
// F5: TTL deploy-lock harus menutupi stage terpanjang (install 2m + build 15m
// + verify). Alih-alih menebak angka statis, lock di-*heartbeat* (refresh TTL)
// selama deploy berjalan — TTL 5 menit hanya jadi batas "pemilik mati".
const LOCK_TTL_MS = 300_000;
const LOCK_HEARTBEAT_MS = 30_000;
const GIT_TIMEOUT_MS = 120_000; // clone/rev-parse timeout 120s
const EVENT_DETAIL_MAX = 2048; // detail event di-clamp 2KB
const HEALTH_RETRIES = 25; // verifying: max 25 percobaan (~12.5s cukup untuk booting cold start Next.js/node)
const HEALTH_RETRY_MS = 500;
const SWEEP_DEFAULT_OLDER_MS = 600_000; // §7.3: disconnected > 10 menit
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 1000;
const GIT_SOURCES_DIR = 'git-sources';
const GIT_SOURCES_KEEP_PER_PROJECT = 2; // GC: simpan 2 clone terbaru per project

/**
 * F5: direktori yang TIDAK ikut hashWorkspace — dependency/artefak besar yang
 * tidak menentukan revision (node_modules, venv, git metadata).
 */
const HASH_IGNORE_DIRS = new Set(['node_modules', '.venv', '.git']);
const HASH_MAX_FILE_BYTES = 32 * 1024 * 1024; // 32MB: file lebih besar → hash meta saja

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
 * F5: node_modules/.venv/.git di-skip (bukan penentu revision) dan file di
 * atas HASH_MAX_FILE_BYTES hanya di-hash metadata (nama+ukuran) — deploy
 * workspace besar tidak lagi membaca ratusan MB ke memori.
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
        if (HASH_IGNORE_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        hash.update(path.relative(wsPath, full).replaceAll('\\', '/'));
        hash.update('\0');
        let size = null;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = null;
        }
        if (size != null && size > HASH_MAX_FILE_BYTES) {
          hash.update(`<large:${size}>`);
        } else {
          try {
            hash.update(fs.readFileSync(full));
          } catch {
            /* file tidak terbaca — skip isinya */
          }
        }
        hash.update('\0');
      }
    }
  }
  return hash.digest('hex').slice(0, 8);
}

export { hashWorkspace };

/**
 * Logger fallback DeploymentManager: #36 butuh mencatat baris bertimestamp
 * rusak tanpa menarik dependensi baru. Default = noop (jangan banjiri stdout
 * test); manager menginjeksi logger nyata di #startModules.
 */
function defaultDeploymentLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg, extra) => console.warn(`[deployment] ${msg}`, extra ?? ''),
    error: (msg, extra) => console.error(`[deployment] ${msg}`, extra ?? ''),
  };
}

/**
 * #36 — Epoch ms dari kolom waktu TEXT dengan Date.parse EKSPLISIT.
 * Perbandingan string ISO lexicografis salah untuk timestamp non-UTC
 * (mis. '...+07:00') dan untuk format rusak; NaN harus di-skip, bukan
 * membuat sweep melempar.
 * @returns {number|null}
 */
function parseTimeMs(value) {
  if (value == null) return null;
  let raw = value;
  if (typeof raw === 'string') {
    const t = raw.trim();
    // Kolom TEXT bisa memuat epoch ms numerik — Date.parse('1700...') = NaN,
    // jadi angka murni diperlakukan sebagai epoch ms, bukan string ISO.
    if (/^-?\d+(\.\d+)?$/.test(t)) raw = Number(t);
    else raw = t;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export { parseTimeMs };

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
   *   logger?: {debug,info,warn,error}|null, // #36: sweep mencatat timestamp rusak
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
    logger = null,
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
    this._lockDir = path.resolve(lockDir ?? path.join(this.dataDir, 'locks'));
    this._redact = makeRedactor();
    this.logger = logger ?? defaultDeploymentLogger();
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
   * F5: heartbeat TTL — deploy panjang (install+build+verify > TTL) tidak
   * pernah kehilangan lock selama proses masih hidup.
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
        {
          dir: this._lockDir,
          ttlMs: LOCK_TTL_MS,
          maxWaitMs: LOCK_WAIT_MS,
          heartbeatMs: LOCK_HEARTBEAT_MS,
        },
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
      let gitCloneDir = null;
      if (source.type === 'git') {
        this._setStage(deploymentId, 'fetching');
        try {
          // Nama dir memuat projectId → GC (_gcGitSources) bisa kelompokkan
          // per project (keep-N) tanpa needing schema baru.
          gitCloneDir = path.join(
            this.dataDir,
            GIT_SOURCES_DIR,
            `git-${projectId}-${genId('dep')}-${Date.now()}`,
          );
          fs.mkdirSync(gitCloneDir, { recursive: true });
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
                gitCloneDir,
              ],
              { timeout: GIT_TIMEOUT_MS },
            );
            const { stdout } = await execFileP(this.gitBin, ['rev-parse', 'HEAD'], {
              cwd: gitCloneDir,
              timeout: GIT_TIMEOUT_MS,
            });
            revision = String(stdout).trim().slice(0, 8);
          } catch (e) {
            try {
              // F5: hapus clone gagal — ternary lama (a ? targetDir : targetDir)
              // selalu cabang yang sama (dead code) → cukup satu path.
              fs.rmSync(gitCloneDir, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 150,
              });
            } catch {
              /* best-effort */
            }
            throw new VmPanelError(VALIDATION, `git clone gagal: ${this._sanitize(e)}`, {
              url: source.url,
              branch: source.branch ?? 'main',
            });
          }
          rootDir = gitCloneDir;
          this._event(deploymentId, 'fetching', 'ok', `revision ${revision} di ${path.basename(gitCloneDir)}`);
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
        return this._fail(deploymentId, 'validating', e);
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

      // (6) F5 GC: clone git lama dibersihkan (keep N terbaru per project),
      // hanya SETELAH deploy sukses — source workspace tidak punya clone.
      if (source.type === 'git') {
        try {
          this._gcGitSources(projectId);
        } catch {
          /* GC best-effort — jangan gagalkan deploy yang sudah sukses */
        }
      }
      return { deploymentId, status: 'success', revision };
    } catch (e) {
      // Safety net — seharusnya tertangkap per-stage.
      return this._fail(deploymentId, 'validating', e);
    }
  }

  /**
   * Inspect workspace hasil deploy → config tambahan untuk service
   * (kontrak adapter.startSpec): node → package.json "main" (pkg.main di
   * NodeAdapter tidak persist antar instance adapter), python → entry script
   * workspace via konvensi adapter (main.py / app.py — pola detect()); project
   * python tanpa entry keduanya → config tanpa main (stage 'validating' yang
   * melaporkan 'python adapter requires config.main'). static/custom → null.
   */
  _deriveServiceConfigExtra(project, rootDir) {
    if (project.type === 'node') {
      const adapter = createAdapter('node', { workspacePath: rootDir, config: {} });
      const v = adapter.validate({ workspacePath: rootDir });
      // main ada = jalur node <main> klasik. npmStart:false eksplisit agar
      // re-deploy menimpa npmStart:true stale di config service lama.
      if (v.main) return { main: v.main, npmStart: false };
      // main null + scripts.start ada = project Next.js-style (npm run start)
      // → TANPA key main sama sekali (bukan undefined) agar startSpec memilih
      // jalur npm-script; sertakan port untuk startSpec di run berikutnya.
      if (v.hasStart !== true) {
        throw new VmPanelError(VALIDATION, 'node adapter requires main atau scripts.start', {
          workspacePath: rootDir,
        });
      }
      return { npmStart: true, ...(Number.isInteger(project.port) ? { port: project.port } : {}) };
    }
    if (project.type === 'python') {
      // 1. Cek startCmd dari project jika ditentukan (misal 'hermes-agent/run_agent.py')
      const rawCmd = project.startCmd || project.start_cmd;
      if (rawCmd && typeof rawCmd === 'string' && rawCmd.trim() !== '') {
        let clean = rawCmd.trim().replace(/^python[0-9.]*\s+/i, '').replace(/^py\s+/i, '').trim();
        clean = clean.replace(/^["']|["']$/g, '');
        if (clean.endsWith('.py')) {
          const full = path.join(rootDir, clean);
          if (fs.existsSync(full)) {
            return { main: clean.replace(/\\/g, '/') };
          }
        }
      }

      // 2. Cek apakah ada layout Hermes Agent (hermes_cli/main.py atau hermes-agent)
      const hasHermesCli = fs.existsSync(path.join(rootDir, 'hermes_cli', 'main.py')) ||
        fs.existsSync(path.join(rootDir, 'hermes-agent', 'hermes_cli', 'main.py'));
      if (hasHermesCli && fs.existsSync(path.join(rootDir, 'main.py'))) {
        return { main: 'main.py' };
      }

      // 3. Cek kandidat populer di root directory (tanpa run_agent.py yang merupakan test/cli script)
      const candidates = [
        'main.py', 'bot.py', 'app.py', 'server.py', 'telegram_bot.py',
        'run.py', 'start.py', 'gateway.py', 'hermes.py', 'agent.py', 'index.py', 'run_agent.py',
      ];
      for (const candidate of candidates) {
        try {
          if (fs.statSync(path.join(rootDir, candidate)).isFile()) {
            return { main: candidate };
          }
        } catch {
          /* coba kandidat berikutnya */
        }
      }

      // 3. Cek file .py apa pun di root
      try {
        const anyPy = fs.readdirSync(rootDir).find((f) => f.endsWith('.py'));
        if (anyPy) return { main: anyPy };
      } catch {}

      // 4. Cari kandidat di subfolder hingga kedalaman 2 (seperti hermes-agent/run_agent.py, src/main.py, app/main.py, bot/bot.py)
      const ignoredDirs = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.idea', '.vscode', 'build', 'dist']);
      try {
        const subEntries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isDirectory() && !ignoredDirs.has(sub.name)) {
            const subPath = path.join(rootDir, sub.name);
            for (const candidate of candidates) {
              const fullCandidate = path.join(subPath, candidate);
              if (fs.existsSync(fullCandidate)) {
                return { main: path.join(sub.name, candidate).replace(/\\/g, '/') };
              }
            }
            // Juga cek depth 2
            try {
              const deepEntries = fs.readdirSync(subPath, { withFileTypes: true });
              for (const deep of deepEntries) {
                if (deep.isDirectory() && !ignoredDirs.has(deep.name)) {
                  const deepPath = path.join(subPath, deep.name);
                  for (const candidate of candidates) {
                    const deepCandidate = path.join(deepPath, candidate);
                    if (fs.existsSync(deepCandidate)) {
                      return { main: path.join(sub.name, deep.name, candidate).replace(/\\/g, '/') };
                    }
                  }
                }
              }
            } catch {}
          }
        }
      } catch {}

      // 5. Fallback ke adapter.validate
      const adapter = createAdapter('python', { workspacePath: rootDir, config: {} });
      const v = adapter.validate({ workspacePath: rootDir }); // error jelas bila tanpa entry
      return { main: v.main ?? null };
    }
    if (project.type === 'static') {
      const candidates = ['public', 'dist', 'build', 'www', 'out', 'html'];
      for (const sub of candidates) {
        const subPath = path.join(rootDir, sub);
        try {
          if (fs.statSync(path.join(subPath, 'index.html')).isFile()) {
            return { rootDir: subPath };
          }
        } catch {}
      }
      return {};
    }
    return {};
  }

  /** healthCheck project (kolom health_url diisi via updateProject) → config service. */
  _projectHealthCheck(project) {
    if (!project.healthCheck) return null;
    if (typeof project.healthCheck === 'object') return project.healthCheck;
    if (typeof project.healthCheck === 'string') {
      try {
        const parsed = JSON.parse(project.healthCheck);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
      return project.healthCheck;
    }
    return null;
  }

  /**
   * Service untuk deploy: existing (listServices project) dipakai ulang —
   * config.rootDir/config.main di-update ke hasil deploy ini; belum ada →
   * createService (config {type, rootDir, main, port, healthCheck}). Port
   * dari project.port.
   */
  _resolveServiceForDeploy(project, rootDir) {
    const cfgExtra = this._deriveServiceConfigExtra(project, rootDir);
    const healthCheck = this._projectHealthCheck(project);
    const existing = this.serviceManager.listServices({ projectId: project.id });
    if (existing && existing.length > 0) {
      const svc = existing[0];
      if (typeof this.serviceManager.updateConfig === 'function') {
        return this.serviceManager.updateConfig(svc.id, {
          rootDir,
          ...cfgExtra,
          ...(Number.isInteger(project.port) ? { port: project.port } : {}),
          ...(healthCheck ? { healthCheck } : {}),
        });
      }
      return svc;
    }
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
      config: {
        rootDir,
        ...cfgExtra,
        ...(Number.isInteger(project.port) ? { port: project.port } : {}),
        ...(healthCheck ? { healthCheck } : {}),
      },
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
      if (res && res.ok === false) {
        throw new VmPanelError(VALIDATION, `${method} gagal: ${res.output ?? 'adapter step failed'}`);
      }
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

  /**
   * Tipe health check efektif untuk service. Urutan sama seperti
   * ServiceManager.healthService: adapter.healthCheckSpec dulu (node/python/
   * static default → {type:'tcp'}), fallback config.healthCheck service.
   * @returns {string|null} 'tcp' | 'http' | 'process' | ... | null
   */
  _healthCheckType(service) {
    const typeOf = (c) => {
      if (c && typeof c === 'object' && typeof c.type === 'string') return c.type;
      if (typeof c === 'string' && c.trim() !== '') return c;
      return null;
    };
    try {
      const adapter = this._adapterFor(service);
      const t = typeOf(
        adapter.healthCheckSpec({
          workspacePath: service?.rootDir ?? service?.config?.rootDir ?? null,
          port: service?.port,
          config: { ...(service?.config ?? {}), port: service?.port },
        }),
      );
      if (t) return t;
    } catch {
      /* adapter tanpa healthCheckSpec — fallback ke config service */
    }
    return typeOf(service?.healthCheck ?? service?.config?.healthCheck ?? null);
  }

  /**
   * verifying: healthService retry HEALTH_RETRIES x HEALTH_RETRY_MS (sleep
   * injectable). F5: fallback "proses masih hidup = sehat" HANYA utk health
   * check tipe 'process' — check tcp/http yang gagal membuat deployment FAILED.
   */
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

    // F5: fallback liveness (proses hidup = sehat) HANYA sah untuk health check
    // tipe 'process' (bot/worker/daemon tanpa listener). Check tcp/http yang
    // gagal → deployment FAILED — jangan topeng service mati.
    let checkType = null;
    try {
      checkType = this._healthCheckType(service);
    } catch {
      checkType = null;
    }
    if (checkType === 'process') {
      try {
        const rec = this.serviceManager.getService(service.id);
        if (rec && rec.status === 'running' && rec.pid) {
          process.kill(rec.pid, 0);
          return `health ok (process-type check, pid ${rec.pid} hidup, tanpa listener)`;
        }
      } catch {
        /* proses mati/tidak aktif */
      }
    }

    throw lastErr ?? new Error('health check gagal setelah retry');
  }

  // ── GC git-sources (F5) ────────────────────────────────────────────────────

  /**
   * Bersihkan direktori clone `data/git-sources/git-<projectId>-*`:
   * simpan `keep` terbaru per project + SEMUA direktori yang masih jadi
   * rootDir service aktif (jangan pernah menghapus source yang dipakai).
   * Dipanggil hanya setelah deploy sukses. Return list path yang dihapus.
   */
  _gcGitSources(projectId, { keep = GIT_SOURCES_KEEP_PER_PROJECT } = {}) {
    if (!isValidId(projectId, 'prj_')) return [];
    const base = path.join(this.dataDir, GIT_SOURCES_DIR);
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return []; // belum pernah ada clone
    }
    const prefix = `git-${projectId}-`;
    const mine = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith(prefix)) continue;
      const full = path.join(base, ent.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      mine.push({ full, name: ent.name, mtimeMs });
    }
    if (mine.length === 0) return [];

    // rootDir yang masih dipakai service project ini → selalu dilindungi.
    const protectedDirs = new Set();
    try {
      for (const svc of this.serviceManager.listServices({ projectId }) ?? []) {
        const rd = svc?.config?.rootDir ?? svc?.rootDir ?? null;
        if (typeof rd === 'string' && rd) protectedDirs.add(path.resolve(rd));
      }
    } catch {
      /* serviceManager tidak menyediakannya — pakai batas keep saja */
    }

    mine.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
    const removed = [];
    for (let i = 0; i < mine.length; i++) {
      const dir = mine[i];
      if (i < keep && !protectedDirs.has(path.resolve(dir.full))) continue;
      if (protectedDirs.has(path.resolve(dir.full))) continue;
      try {
        fs.rmSync(dir.full, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
        removed.push(dir.full);
      } catch {
        /* Windows EBUSY (editor/AVC memegang handle) — coba lagi GC berikutnya */
      }
    }
    return removed;
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
        lockDir: this._lockDir,
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
   *
   * F5: setiap baris diproses DI DALAM lock `deploy-<projectId>` yang sama
   * dengan deploy(). Rollback dipanggil dengan `{ lock: false }` karena lock
   * sudah dipegang sweep (file lock tidak re-entrant — mengambilnya lagi
   * = self-deadlock/LOCK_HELD). Baris whose lock masih dipegang deploy hidup
   * DI-LEWATI (deployment-nya belum yatim) dan muncul sebagai skipped.
   */
  async sweepDisconnected({ olderThanMs = SWEEP_DEFAULT_OLDER_MS } = {}) {
    const ms = Number(olderThanMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new VmPanelError(VALIDATION, 'olderThanMs wajib angka > 0', { olderThanMs });
    }
    // #36 — cutoff dibandingkan sebagai EPOCH ms (Date.parse eksplisit), bukan
    // string ISO lexicografis: string compare salah untuk offset non-UTC
    // ('…+07:00' > '…Z' secara lexicografis) dan membuat baris rusak ikut
    // tersapu/melempar.
    const cutoffMs = this._now().getTime() - ms;
    const running = this.store.db
      .prepare(`SELECT * FROM deployments WHERE status = 'running' AND started_at IS NOT NULL`)
      .all();
    const stale = [];
    for (const row of running) {
      const startedMs = parseTimeMs(row.started_at);
      if (startedMs == null) {
        this.logger.warn('deployment.sweep.skipped_unparsable_started_at', {
          deploymentId: row.id ?? null,
          projectId: row.project_id ?? null,
          started_at: String(row.started_at),
        });
        continue; // baris bertimestamp rusak: lewati, jangan throw / jangan rollback
      }
      if (startedMs < cutoffMs) stale.push(row);
    }

    const rolledBack = [];
    for (const row of stale) {
      if (!isValidId(row.project_id, 'prj_')) {
        // projectId tak valid → tidak bisa dikunci; tandai gagal tanpa rollback.
        this._markDisconnected(row);
        rolledBack.push({
          deploymentId: row.id,
          projectId: row.project_id,
          rollback: { error: 'projectId tidak valid — auto-rollback dilewati' },
        });
        continue;
      }
      try {
        const done = await withLock(
          `deploy-${row.project_id}`,
          {
            dir: this._lockDir,
            ttlMs: LOCK_TTL_MS,
            maxWaitMs: LOCK_WAIT_MS,
            heartbeatMs: LOCK_HEARTBEAT_MS,
          },
          async () => {
            this._markDisconnected(row);
            let rollback = null;
            try {
              const rm = this._ensureRollbackManager();
              rollback = await rm.rollback({
                projectId: row.project_id,
                actor: 'system:auto-rollback',
                lock: false, // sudah dipegang sweep — sadar re-entrancy
              });
              this._event(row.id, 'disconnected', 'ok', `auto-rollback sukses → ${rollback.to}`);
            } catch (e) {
              // Tidak ada revision sukses / service hilang — catat, jangan crash.
              this._event(row.id, 'disconnected', 'fail', `auto-rollback gagal: ${this._sanitize(e)}`);
              rollback = { error: this._sanitize(e) };
            }
            return { deploymentId: row.id, projectId: row.project_id, rollback };
          },
        );
        rolledBack.push(done);
      } catch (e) {
        if (e && e.code === 'LOCK_HELD') {
          // Deploy masih hidup untuk project ini → JANGAN sentuh barisnya.
          rolledBack.push({
            deploymentId: row.id,
            projectId: row.project_id,
            skipped: true,
            reason: 'lock-held (deploy masih berjalan)',
            rollback: null,
          });
          continue;
        }
        throw e;
      }
    }
    return rolledBack;
  }

  /** Tandai satu deployment row sebagai failed/disconnected + event-nya. */
  _markDisconnected(row) {
    this.store.db
      .prepare(
        `UPDATE deployments SET status = 'failed', stage = 'disconnected', error = ?, finished_at = ? WHERE id = ?`,
      )
      .run('deployment disconnected (marker success tidak ter-set)', this._iso(), row.id);
    this._event(row.id, 'disconnected', 'fail', 'deployment terputus — auto-rollback §7.3');
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
