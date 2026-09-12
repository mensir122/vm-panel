// manager/index.js — daemon VM-Panel Manager (docs/DESIGN.md §2.2, §2.3, §2.5).
// Manager = SATU-SATUNYA penulis 9 DB SQLite. Fase ini (F1 Wave 2):
//   start(): openDatabase platform/projects/services + migrate + integrityCheck
//   (gagal → REFUSE_START_DB), setMeta platform (manager_started_at, runner_id,
//   host_mode), lazy/dynamic import AuditManager + PermissionManager (modul
//   rekan — jangan diubah), HTTP API loopback (manager/api.js), PID file
//   atomic runtime/pid/manager.pid, audit event system.startup.
//   stop(): graceful — tutup HTTP → audit system.shutdown → close DB → hapus
//   PID file. Supervisor nyata = InternalSupervisor (#startModules); guard
//   crash F7 = installCrashGuards() (log redacted + stop() sekali).

import { join } from 'node:path';
import { chmodSync, existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { VmPanelError, REFUSE_START_DB, VALIDATION } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';
import { makeRedactor } from '../lib/redact.js';
import { randomToken } from '../lib/crypto.js';
import { atomicWriteFile, ensureDir } from '../lib/fsutil.js';
import { createApiServer } from './api.js';
import { registerDataRoutes } from './api-data-routes.js';

const VERSION = '0.1.0';
const PID_FILE_REL = join('runtime', 'pid', 'manager.pid');

/** Kolom wajib integrity per DB — hasil integrityCheck().ok false → refuse. */
const DB_SPECS = Object.freeze([
  { key: 'platform', file: 'platform.db', schemaName: 'platform' },
  { key: 'projects', file: 'projects.db', schemaName: 'projects' },
  { key: 'services', file: 'services.db', schemaName: 'services' },
]);

function refuseStartDb(dbKey, details) {
  return new VmPanelError(
    REFUSE_START_DB,
    `integritas ${dbKey} gagal — manager menolak start (tidak auto-delete)`,
    details,
  );
}

export class Manager {
  /**
   * @param {{rootDir: string, config?: object, token?: string,
   *          logger?: object}} opts
   */
  constructor({ rootDir, config, token, logger } = {}) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'Manager: rootDir wajib');
    }
    this.rootDir = rootDir;
    this.dataDir = join(rootDir, 'data');
    this.config = config ?? null;
    this.version = VERSION;
    this.logger =
      logger ??
      createLogger({ dir: join(rootDir, 'logs', 'manager'), name: 'manager', redactor: makeRedactor({ extraValues: token ? [token] : [] }) });
    // Token API: argumen > env > random sekali per proses (loopback-only).
    this.token = typeof token === 'string' && token.length > 0 ? token : process.env.MANAGER_API_TOKEN || randomToken(32);

    this.dbs = { platform: null, projects: null, services: null };
    this.auditManager = null;
    this.permissionManager = null;
    // Modul F2/F3/F4 — diinisialisasi lazy di #startModules() saat start().
    this.processManager = null;
    this.projectManager = null;
    this.serviceManager = null;
    this.healthManager = null;
    this.deploymentManager = null;
    this.rollbackManager = null;
    this.backupManager = null;
    this.restoreManager = null;
    this.exportManager = null;
    this.importManager = null;
    this.secretManager = null;
    this.internalSupervisor = null; // InternalSupervisor — TIDAK auto-start default
    this.supervisorStarted = false;
    this.cliTokenPath = null;
    this.api = null; // {server, port, close} dari createApiServer
    this.systemUserId = null; // owner-bootstrap user id (actor 'system')
    this.startedAt = null;
    this.running = false;
    this.runnerId = process.env.RUNNER_ID || 'local';
  }

  get hostMode() {
    return this.config?.manager?.hostMode ?? 'dev';
  }

  get apiPort() {
    return this.config?.manager?.apiPort ?? 8097;
  }

  /** Snapshot status untuk GET /system/status. */
  systemStatus() {
    return {
      status: this.running ? 'running' : 'stopped',
      uptimeSec: this.running && this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      pid: process.pid,
      hostMode: this.hostMode,
      runnerId: this.runnerId,
      startedAt: this.startedAt,
      version: this.version,
    };
  }

  /** GET /projects — list dari projects.db (kosong → []). */
  listProjects() {
    const h = this.dbs.projects;
    if (!h) return [];
    const rows = h.db
      .prepare('SELECT id, name, type, status, created_at, updated_at FROM projects ORDER BY name')
      .all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * (a) Open platform/projects/services + migrate + integrityCheck.
   * Kegagalan open/migrate/integrity → REFUSE_START_DB (log detail, throw).
   */
  #openDatabases() {
    ensureDir(this.dataDir); // data/ wajib ada sebelum openDatabase
    for (const spec of DB_SPECS) {
      const path = join(this.dataDir, spec.file);
      let h;
      try {
        h = openDatabase(path, { schemaName: spec.schemaName });
        h.migrate();
        const ic = h.integrityCheck();
        if (!ic.ok) {
          throw refuseStartDb(spec.key, ic.details);
        }
      } catch (e) {
        try {
          h?.close();
        } catch {
          /* abaikan */
        }
        if (e instanceof VmPanelError && e.code === REFUSE_START_DB) {
          this.logger.error('manager.refuse_start_db', { db: spec.key, reason: e.message });
          throw e;
        }
        const err = new VmPanelError(
          REFUSE_START_DB,
          `openDatabase ${spec.file} gagal: ${e?.message ?? e}`,
          { db: spec.key, cause: String(e?.code ?? '') },
        );
        this.logger.error('manager.refuse_start_db', { db: spec.key, reason: err.message });
        throw err;
      }
      this.dbs[spec.key] = h;
      this.logger.info('manager.db_open', { db: spec.key, file: spec.file });
    }
  }

  /** (b) setMeta platform: manager_started_at, runner_id, host_mode. */
  #writePlatformMeta() {
    const h = this.dbs.platform;
    h.setMeta('manager_started_at', new Date().toISOString());
    h.setMeta('runner_id', this.runnerId);
    h.setMeta('host_mode', this.hostMode);
  }

  /**
   * (c) Lazy/dynamic import modul rekan (Wave 2, lane lain) — file itu
   * DILARANG disentuh; kontrak: AuditManager({dataDir}).append/list,
   * PermissionManager({dataDir}).ensureOwnerBootstrap/checkPermission.
   */
  async #loadPartnerModules() {
    const { AuditManager } = await import('./audit_manager/index.js');
    const { PermissionManager } = await import('./permission_manager/index.js');
    this.auditManager = new AuditManager({
      dataDir: this.dataDir,
      logDir: join(this.rootDir, 'logs', 'manager'),
    });
    this.permissionManager = new PermissionManager({ dataDir: this.dataDir });
    // Owner-bootstrap: actor 'system' untuk cek permission /audit.
    const boot = this.permissionManager.ensureOwnerBootstrap({ username: 'system' });
    if (boot?.created && boot.userId) {
      this.systemUserId = boot.userId;
      this.logger.info('manager.owner_bootstrap_created', { userId: boot.userId });
    } else {
      // Sudah ada user: pakai user 'system' bila ada, otherwise null
      // (null → /audit menganggap fase owner-bootstrap → allowed).
      const sysUser = this.permissionManager.getUserByUsername?.('system');
      this.systemUserId = sysUser?.userId ?? null;
    }
  }

  /**
   * (c2) Inisialisasi lazy modul F2/F3/F4 (process/project/service/health/
   * deployment/rollback/backup/restore/export/import + InternalSupervisor).
   * Urutan DI: processManager dulu (butuh rootDir), lalu sisanya; supervisor
   * dibuat dengan DI lengkap TAPI TIDAK auto-start (config.supervisor.autoStart
   * default false; true → start()).
   * @private
   */
  async #startModules() {
    const cfg = this.config ?? {};
    const supCfg = cfg.supervisor ?? {};

    const { ProcessManager } = await import('./process_manager/index.js');
    this.processManager = new ProcessManager({ rootDir: this.rootDir });

    const { ProjectManager } = await import('./project_manager/index.js');
    this.projectManager = new ProjectManager({
      dataDir: this.dataDir,
      workspacesRoot: join(this.rootDir, 'workspaces'),
      processManager: this.processManager,
    });

    const { HealthManager } = await import('./health_manager/index.js');
    this.healthManager = new HealthManager({ dataDir: this.dataDir });

    const { ServiceManager } = await import('./service_manager/index.js');
    this.serviceManager = new ServiceManager({
      dataDir: this.dataDir,
      processManager: this.processManager,
      auditManager: this.auditManager,
      projectsDbPath: join(this.dataDir, 'projects.db'),
      logger: this.logger,
    });

    const { RollbackManager } = await import('./rollback_manager/index.js');
    this.rollbackManager = new RollbackManager({
      dataDir: this.dataDir,
      serviceManager: this.serviceManager,
      healthManager: this.healthManager,
      // Gate-1 F5 (warisan M-B): lock 'deploy-<prj>' rollback SATU direktori
      // dengan DeploymentManager/backup/supervisor (runtime/locks) — guard
      // deploy-vs-rollback harus saling melihat.
      lockDir: join(this.rootDir, 'runtime', 'locks'),
    });

    const { DeploymentManager } = await import('./deployment_manager/index.js');
    this.deploymentManager = new DeploymentManager({
      dataDir: this.dataDir,
      serviceManager: this.serviceManager,
      projectManager: this.projectManager,
      healthManager: this.healthManager,
      rollbackManager: this.rollbackManager,
      logger: this.logger,
      // Gate-1 F5/lockDir: deploy lock 'deploy-<prj>' harus SATU direktori
      // dengan lock supervisor/backup (runtime/locks) — default lama
      // dataDir/locks membuat kedua dunia saling tidak melihat.
      lockDir: join(this.rootDir, 'runtime', 'locks'),
    });

    const { BackupManager } = await import('./backup_manager/index.js');
    this.backupManager = new BackupManager({
      dataDir: this.dataDir,
      backupsRoot: join(this.rootDir, 'backups'),
      lockDir: join(this.rootDir, 'runtime', 'locks'),
      retention: cfg.backup?.retention,
    });

    const { RestoreManager } = await import('./restore_manager/index.js');
    this.restoreManager = new RestoreManager({
      dataDir: this.dataDir,
      backupsRoot: join(this.rootDir, 'backups'),
      backupManager: this.backupManager,
    });

    const { ExportManager } = await import('./export_manager/index.js');
    this.exportManager = new ExportManager({ dataDir: this.dataDir });

    const { ImportManager } = await import('./import_manager/index.js');
    this.importManager = new ImportManager({ dataDir: this.dataDir });

    const { SecretManager } = await import('./secret_manager/index.js');
    this.secretManager = new SecretManager({
      rootDir: this.rootDir,
      dataDir: this.dataDir,
      masterKey: process.env.VPANEL_MASTER_KEY,
      projectsDb: this.dbs.projects?.db ?? null,
    });

    const { InternalSupervisor } = await import('./recovery_manager/index.js');
    this.internalSupervisor = new InternalSupervisor({
      serviceManager: this.serviceManager,
      healthManager: this.healthManager,
      processManager: this.processManager,
      logger: this.logger,
      pollIntervalMs: (supCfg.pollIntervalSec ?? 5) * 1000,
      maxRestarts: supCfg.maxRestarts ?? 5,
      backoffSeq: Array.isArray(supCfg.backoffSeq) ? supCfg.backoffSeq : undefined,
      stableWindowMs: (supCfg.stableWindowSec ?? 600) * 1000,
      notificationWebhook: supCfg.notificationWebhook ?? null,
      lockDir: join(this.rootDir, 'runtime', 'locks'),
      // Warisan M-B (F5 wire): aktifkan sweepDeployments() §7.3 di tick;
      // tanpa injeksi ini sweep no-op di produksi.
      deploymentManager: this.deploymentManager,
      deploySweepIntervalMs: (supCfg.deploySweepIntervalSec ?? 300) * 1000,
    });
    this.logger.info('manager.modules_ready', {
      process: !!this.processManager,
      project: !!this.projectManager,
      service: !!this.serviceManager,
      health: !!this.healthManager,
      deployment: !!this.deploymentManager,
      backup: !!this.backupManager,
      supervisor: 'created-not-started',
    });

    // #31b — Rekonsiliasi baris 'running' yatim SEBELUM supervisor auto-start:
    // manager yang crash/restart meninggalkan status 'running' padahal prosesnya
    // sudah mati. Error di sini tidak boleh memblok start (supervisor tetap
    // bisa jalan; baris akan ditangani branch DEAD pada tick pertama).
    try {
      const rec = await this.serviceManager.reconcileStaleRunning();
      if (rec.checked > 0) {
        this.logger.info('manager.service_reconciled', {
          checked: rec.checked,
          failed: rec.reconciled.length,
          orphanAlive: rec.orphans.length,
        });
      }
    } catch (e) {
      this.logger.warn('manager.service_reconcile_failed', {
        reason: String(e?.message ?? e),
      });
    }

    // Auto-start HANYA bila config.supervisor.autoStart === true (default false).
    const autoStart = supCfg.autoStart === true || supCfg.auto_start === true;
    if (autoStart) {
      await this.internalSupervisor.start();
      this.supervisorStarted = true;
      this.logger.info('manager.supervisor_autostarted', {});
    }
  }

  /**
   * Tulis token API ke runtime/sockets/cli-token (idempotent) — dibaca
   * vmctl & panel. Mode 600 di POSIX (best-effort di Windows).
   * @private
   */
  #writeCliToken() {
    const dir = join(this.rootDir, 'runtime', 'sockets');
    ensureDir(dir);
    const tokenPath = join(dir, 'cli-token');
    const content = `${this.token}\n`;
    let same = false;
    try {
      same = readFileSync(tokenPath, 'utf8') === content;
    } catch {
      same = false;
    }
    if (!same) {
      atomicWriteFile(tokenPath, content);
      if (process.platform !== 'win32') {
        try {
          chmodSync(tokenPath, 0o600);
        } catch {
          /* best-effort */
        }
      }
    }
    this.cliTokenPath = tokenPath;
    this.logger.info('manager.cli_token_written', { path: 'runtime/sockets/cli-token' });
  }

  /**
   * (d)+(e)+(f) API server, PID file, audit system.startup.
   * @private
   */
  async #startApiAndPid() {
    // (d) HTTP API loopback + bearer + data routes F4
    this.api = await createApiServer({
      manager: this,
      port: this.apiPort,
      token: this.token,
      dataRoutes: registerDataRoutes({ manager: this }),
    });

    // (e) PID file atomic
    const pidPath = join(this.rootDir, PID_FILE_REL);
    this.pidPath = pidPath;
    atomicWriteFile(pidPath, String(process.pid) + '\n');

    // (e2) cli-token untuk vmctl/panel (idempotent)
    this.#writeCliToken();

    // (f) audit + log
    this.auditManager?.append({
      actor: 'system',
      operation: 'system.startup',
      input: { pid: process.pid, apiPort: this.api.port, hostMode: this.hostMode, runnerId: this.runnerId },
      result: 'ok',
    });
    this.logger.info('manager.started', {
      pid: process.pid,
      apiPort: this.api.port,
      hostMode: this.hostMode,
      runnerId: this.runnerId,
      version: this.version,
    });
  }

  /** Start manager penuh. Idempotent-guard: start dua kali → VALIDATION. */
  async start() {
    if (this.running) {
      throw new VmPanelError(VALIDATION, 'Manager.start: sudah berjalan');
    }
    this.logger.info('manager.starting', { rootDir: this.rootDir, dataDir: this.dataDir });
    this.#openDatabases(); // (a) — throw REFUSE_START_DB bila gagal
    this.#writePlatformMeta(); // (b)
    await this.#loadPartnerModules(); // (c) — lazy import rekan Wave 2
    await this.#startModules(); // (c2) — lazy init modul F2/F3/F4 + supervisor
    await this.#startApiAndPid(); // (d)(e)(f)
    this.startedAt = Date.now();
    this.running = true;
    return { apiPort: this.api.port, token: this.token };
  }

  /**
   * Pembersihan total project secara atomik & tuntas (Clean Purge).
   * Menghapus semua service, proses, port, deployment, secret/config,
   * workspace fisik, dan baris projects.db.
   */
  async purgeProject(id, { confirmToken, actor = 'system' } = {}) {
    if (!this.projectManager) {
      throw new VmPanelError(VALIDATION, 'ProjectManager belum siap');
    }
    const project = this.projectManager.getProject(id);
    const projectName = project.name;

    // 1. Hentikan & hapus semua service yang terkait project ini
    if (this.serviceManager?.store?.db) {
      try {
        const svcs = this.serviceManager.store.db
          .prepare('SELECT id, status FROM services WHERE project_id = ?')
          .all(id);
        for (const s of svcs) {
          try {
            if (s.status === 'running') {
              await this.serviceManager.stopService(s.id, { graceMs: 3000 });
            }
          } catch (e) {
            this.logger.warn('manager.purge_service_stop_failed', { serviceId: s.id, reason: String(e?.message ?? e) });
          }
          try {
            this.serviceManager.releasePort(s.id);
          } catch {}
          try {
            this.serviceManager.store.db.prepare('DELETE FROM service_supervisor_state WHERE service_id = ?').run(s.id);
            this.serviceManager.store.db.prepare('DELETE FROM services WHERE id = ?').run(s.id);
          } catch (e) {
            this.logger.warn('manager.purge_service_delete_failed', { serviceId: s.id, reason: String(e?.message ?? e) });
          }
        }
      } catch (e) {
        this.logger.warn('manager.purge_services_query_failed', { projectId: id, reason: String(e?.message ?? e) });
      }
    }

    // 2. Hapus semua deployment, deployment_events, dan revisions terkait
    if (this.deploymentManager?.store?.db) {
      try {
        const depDb = this.deploymentManager.store.db;
        depDb.prepare('DELETE FROM deployment_events WHERE deployment_id IN (SELECT id FROM deployments WHERE project_id = ?)').run(id);
        depDb.prepare('DELETE FROM deployments WHERE project_id = ?').run(id);
        depDb.prepare('DELETE FROM revisions WHERE project_id = ?').run(id);
      } catch (e) {
        this.logger.warn('manager.purge_deployments_failed', { projectId: id, reason: String(e?.message ?? e) });
      }
    }

    // 3. Bersihkan secret refs, hooks, dan custom configs terkait project
    if (this.secretManager) {
      try {
        this.secretManager.removeProjectHook(id);
      } catch {}
      try {
        const envs = this.secretManager.listProjectEnv(id);
        for (const e of envs) {
          this.secretManager.removeProjectEnv(id, e.envName);
        }
      } catch {}
      try {
        const cfgDir = this.secretManager._projectConfigDir(id);
        if (existsSync(cfgDir)) {
          rmSync(cfgDir, { recursive: true, force: true });
        }
      } catch {}
    }

    // 4. Hapus workspace fisik & row project via ProjectManager
    const tok = confirmToken || 'PURGE_CONFIRMED';
    this.projectManager.removeProject(id, { confirmToken: tok, expectedToken: tok });

    // 5. Catat audit event
    try {
      this.auditManager?.append({
        actor,
        operation: 'project.delete',
        input: { projectId: id, name: projectName },
        result: 'ok',
      });
    } catch {}

    this.logger.info('manager.project_purged', { projectId: id, name: projectName });
    return { ok: true, removed: true, id, name: projectName };
  }

  /**
   * Graceful stop: tutup HTTP server → audit system.shutdown → close DB
   * (platform/projects/services) → hapus PID file. Error per-langkah
   * dicatat tapi tidak menghentikan langkah berikutnya.
   */
  async stop() {
    this.running = false;
    // 1. HTTP server
    if (this.api) {
      try {
        await this.api.close();
      } catch (e) {
        this.logger.warn('manager.stop_api_close_failed', { reason: String(e?.message ?? e) });
      } finally {
        this.api = null;
      }
    }
    // 2. audit shutdown
    try {
      this.auditManager?.append({
        actor: 'system',
        operation: 'system.shutdown',
        input: { pid: process.pid, graceful: true },
        result: 'ok',
      });
    } catch (e) {
      this.logger.warn('manager.stop_audit_failed', { reason: String(e?.message ?? e) });
    }
    // 3. close partner modules (rekan miliki koneksi audit.db/users.db sendiri)
    for (const [name, mod] of [
      ['auditManager', this.auditManager],
      ['permissionManager', this.permissionManager],
    ]) {
      if (mod) {
        try {
          mod.close();
        } catch (e) {
          this.logger.warn('manager.stop_module_close_failed', { module: name, reason: String(e?.message ?? e) });
        }
      }
    }
    this.auditManager = null;
    this.permissionManager = null;
    // 3b. stop supervisor + close modul F2/F3/F4 (milik koneksi DB sendiri)
    try {
      this.internalSupervisor?.stop?.();
    } catch (e) {
      this.logger.warn('manager.stop_supervisor_failed', { reason: String(e?.message ?? e) });
    }
    this.internalSupervisor = null;
    this.supervisorStarted = false;
    for (const [name, mod] of [
      ['projectManager', this.projectManager],
      ['serviceManager', this.serviceManager],
      ['healthManager', this.healthManager],
      ['deploymentManager', this.deploymentManager],
      ['rollbackManager', this.rollbackManager],
      ['backupManager', this.backupManager],
    ]) {
      if (mod) {
        try {
          mod.close?.();
        } catch (e) {
          this.logger.warn('manager.stop_module_close_failed', { module: name, reason: String(e?.message ?? e) });
        }
      }
    }
    this.processManager = null;
    this.projectManager = null;
    this.serviceManager = null;
    this.healthManager = null;
    this.deploymentManager = null;
    this.rollbackManager = null;
    this.backupManager = null;
    this.restoreManager = null;
    this.exportManager = null;
    this.importManager = null;
    this.secretManager = null;
    // 4. close DB
    for (const key of ['projects', 'services', 'platform']) {
      const h = this.dbs[key];
      if (h) {
        try {
          h.close();
        } catch (e) {
          this.logger.warn('manager.stop_db_close_failed', { db: key, reason: String(e?.message ?? e) });
        }
      }
      this.dbs[key] = null;
    }
    // 5. hapus PID file + cli-token
    if (this.pidPath && existsSync(this.pidPath)) {
      try {
        unlinkSync(this.pidPath);
      } catch (e) {
        this.logger.warn('manager.stop_pid_remove_failed', { reason: String(e?.message ?? e) });
      }
    }
    this.pidPath = null;
    if (this.cliTokenPath && existsSync(this.cliTokenPath)) {
      try {
        unlinkSync(this.cliTokenPath);
      } catch (e) {
        this.logger.warn('manager.stop_cli_token_remove_failed', { reason: String(e?.message ?? e) });
      }
    }
    this.cliTokenPath = null;
    this.startedAt = null;
    this.logger.info('manager.stopped', { pid: process.pid, graceful: true });
  }
}

/**
 * F7 — guard crash untuk proses daemon: unhandledRejection/uncaughtException
 * dulu DIAM-DIAM membunuh manager (atau membiarkan setengah-hidup) tanpa jejak
 * terstruktur. Sekarang: log REDACTED (logger sudah membawa redactor + token
 * di extraValues) → stop() terkontrol SEKALI (guard reentrancy — event
 * kedua selama shutdown langsung diabaikan) → exit(1).
 *
 * Diekspor agar unit test bisa memancarkan event tanpa menjalankan daemon.
 * @param {Manager} manager
 * @param {{exit?: (code: number) => void, emitter?: {on: Function, off?: Function}}} [opts]
 *   emitter default = process global; injectable agar unit test tidak
 *   mencemari listener proses test-runner.
 * @returns {{dispose: () => void}} penghapus listener (dipakai test)
 */
export function installCrashGuards(
  manager,
  { exit = (code) => process.exit(code), emitter = process } = {},
) {
  const redactor = makeRedactor();
  let fired = false;
  const handle = (label) => (err) => {
    if (fired) return; // reentrancy: shutdown sedang berjalan — abaikan
    fired = true;
    const reason = redactor(String(err?.stack ?? err?.message ?? err ?? label));
    try {
      manager.logger?.error?.(label, { reason: typeof reason === 'string' ? reason : String(reason) });
    } catch {
      /* logger mati — jangan sampai guard ikut crash */
    }
    Promise.resolve()
      .then(() => manager.stop?.())
      .catch(() => {
        /* stop gagal — tetap exit terkontrol */
      })
      .finally(() => exit(1));
  };
  const onRejection = handle('manager.unhandled_rejection');
  const onException = handle('manager.uncaught_exception');
  emitter.on('unhandledRejection', onRejection);
  emitter.on('uncaughtException', onException);
  return {
    dispose() {
      emitter.off?.('unhandledRejection', onRejection);
      emitter.off?.('uncaughtException', onException);
    },
  };
}

/** CLI entrypoint langsung: `node manager/index.js`. */
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { loadDotEnv } = await import('../lib/env.js');
  loadDotEnv(process.env.VPANEL_ROOT || process.cwd());
  const { loadConfig } = await import('../lib/config.js');
  const config = loadConfig({ rootDir: process.env.VPANEL_ROOT || process.cwd() });
  const manager = new Manager({ rootDir: config.rootDir, config });
  installCrashGuards(manager); // F7
  const shutdown = async (sig) => {
    manager.logger.info('manager.signal', { signal: sig });
    await manager.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  manager.start().catch((e) => {
    manager.logger.error('manager.start_failed', {
      code: e?.code ?? 'UNKNOWN',
      reason: String(e?.message ?? e),
    });
    process.exit(1);
  });
}
