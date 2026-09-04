// manager/adapters/base.js — kontrak adapter (docs/DESIGN.md §2.6, §7.1).
// Semua adapter mewarisi BaseAdapter. Method yang tidak di-overwrite
// default throw VALIDATION 'not implemented' — memaksa adapter eksplisit.

import fs from 'node:fs';
import { VmPanelError, VALIDATION, NOT_FOUND } from '../../lib/errors.js';

/**
 * BaseAdapter — kontrak lifecycle adapter (DESIGN.md §2.6):
 * detect() → validate() → prepare() → install() → configure()
 * → startSpec() → healthCheckSpec() → stopSpec() → cleanup()
 * → exportState() / restoreState().
 *
 * Dipanggil DeploymentManager dengan error isolation per adapter
 * (DESIGN.md §7.3): semua kegagalan dilempar sebagai VmPanelError.
 */
export class BaseAdapter {
  /**
   * @param {{name?: string, workspacePath?: string, config?: object}} opts
   *   - name: nama adapter (mis. 'static', 'node', 'python')
   *   - workspacePath: default workspace bila ctx/service tidak membawanya
   *   - config: default config project (port, main, dsb.)
   */
  constructor({ name = 'base', workspacePath = null, config = {} } = {}) {
    this.name = name;
    this.workspacePath = workspacePath;
    this.config = config ?? {};
  }

  /** Ambil workspace dari ctx/service, fallback ke constructor. Wajib ada di disk. */
  assertWorkspace(ctx = {}) {
    const ws = ctx?.workspacePath ?? this.workspacePath;
    if (!ws || typeof ws !== 'string' || !fs.existsSync(ws)) {
      throw new VmPanelError(NOT_FOUND, 'workspace tidak ditemukan', { workspacePath: ws ?? null });
    }
    return ws;
  }

  /** Gabungkan config adapter + config service, ambil port wajib yang valid. */
  requirePort(service = {}) {
    const raw = service?.port ?? service?.config?.port ?? this.config?.port;
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new VmPanelError(VALIDATION, 'port wajib (config.port)', { port: raw ?? null });
    }
    return port;
  }

  /** @protected */
  notImplemented(method) {
    throw new VmPanelError(VALIDATION, `not implemented: ${this.name}.${method}()`, {
      adapter: this.name,
      method,
    });
  }

  /**
   * Deteksi apakah workspace cocok untuk adapter ini.
   * @param {{workspacePath?: string}} [ctx]
   * @returns {boolean}
   */
  detect(ctx = {}) {
    this.notImplemented('detect');
  }

  /**
   * Validasi config + workspace sebelum lifecycle lanjut.
   * @param {object} [config]
   * @returns {{ok: boolean, [k: string]: any}}
   */
  validate(config = {}) {
    this.notImplemented('validate');
  }

  /** Tahap persiapan (mis. copy build output). */
  prepare(ctx = {}) {
    this.notImplemented('prepare');
  }

  /**
   * Instalasi dependency (mis. npm ci / pip install).
   * @param {object} [ctx]
   * @param {{execFile?: Function}} [deps] injeksi eksekutor untuk testability
   * @returns {Promise<{ok: boolean, [k: string]: any}>}
   */
  install(ctx = {}, deps = {}) {
    this.notImplemented('install');
  }

  /** Konfigurasi akhir (port, env, template config). */
  configure(ctx = {}) {
    this.notImplemented('configure');
  }

  /**
   * Susun spesifikasi start proses untuk ProcessManager.
   *
   * Kontrak hasil (DESIGN.md §2.2: child_process no-shell):
   * ```
   * {
   *   argv: [string, ...],  // argv murni — TANPA shell string; argv[0] executable
   *   cwd: string,          // direktori kerja proses
   *   env: object,          // env TERPISAH (whitelist), bukan process.env
   *   port: number          // port yang akan di-bind service
   * }
   * ```
   * ProcessManager memanggil child_process.spawn(argv[0], argv.slice(1),
   * { cwd, env }) — tidak pernah melewati shell.
   *
   * @param {{workspacePath?: string, config?: object, port?: number}} [service]
   * @returns {{argv: string[], cwd: string, env: object, port: number}}
   */
  startSpec(service = {}) {
    this.notImplemented('startSpec');
  }

  /** Hentikan proses service (graceful). */
  stopSpec() {
    this.notImplemented('stopSpec');
  }

  /**
   * Spesifikasi health check (DESIGN.md §7A.1).
   * @returns {{type: 'http'|'tcp'|'command'|'db'|'process', [k: string]: any}}
   */
  healthCheckSpec(service = {}) {
    this.notImplemented('healthCheckSpec');
  }

  /** Bersihkan artefak sementara setelah deployment. */
  cleanup() {
    this.notImplemented('cleanup');
  }

  /** Ekspor state adapter (untuk export project / migration). */
  exportState() {
    this.notImplemented('exportState');
  }

  /** Pulihkan state dari hasil exportState(). */
  restoreState() {
    this.notImplemented('restoreState');
  }
}
