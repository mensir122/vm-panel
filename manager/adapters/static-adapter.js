// manager/adapters/static-adapter.js — adapter situs statis (DESIGN.md §2.6 baris "static").
// Serve file statis dari workspace via static-server.js (subproses manager, no-shell argv).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VmPanelError, VALIDATION } from '../../lib/errors.js';
import { BaseAdapter } from './base.js';

const STATIC_SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static-server.js');

/** Cari direktori yang berisi index.html (rootDir atau subfolder standar public/dist/build/www/out/html). */
function findIndexHtmlDir(dir) {
  if (!dir) return null;
  const candidates = ['', 'public', 'dist', 'build', 'www', 'out', 'html'];
  for (const sub of candidates) {
    const target = sub ? path.join(dir, sub) : dir;
    try {
      if (fs.statSync(path.join(target, 'index.html')).isFile()) {
        return target;
      }
    } catch {}
  }
  return null;
}

function hasIndexHtml(dir) {
  return Boolean(findIndexHtmlDir(dir));
}

export class StaticAdapter extends BaseAdapter {
  /** @param {{workspacePath?: string, config?: object}} [opts] */
  constructor(opts = {}) {
    super({ name: 'static', ...opts });
  }

  /** True jika workspace berisi index.html (di root atau subfolder standar). */
  detect(ctx = {}) {
    const ws = ctx?.workspacePath ?? this.workspacePath;
    if (!ws) return false;
    return hasIndexHtml(ws);
  }

  /**
   * config.rootDir (default workspacePath) wajib ada & berisi index.html;
   * port wajib via config.port.
   * @returns {{ok: true, rootDir: string, port: number}}
   */
  validate(config = {}) {
    const cfg = { ...this.config, ...config };
    const rawDir = cfg.rootDir ?? this.workspacePath;
    const targetDir = findIndexHtmlDir(rawDir);
    if (!rawDir || !fs.existsSync(rawDir) || !targetDir) {
      throw new VmPanelError(VALIDATION, 'static adapter requires index.html', {
        rootDir: rawDir ?? null,
      });
    }
    const port = Number(cfg.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new VmPanelError(VALIDATION, 'port wajib via config.port', { port: cfg.port ?? null });
    }
    return { ok: true, rootDir: fs.realpathSync(targetDir), port };
  }

  /** Tidak ada langkah instalasi untuk situs statis. */
  async install() {
    return { ok: true, output: '' };
  }

  /**
   * @param {{workspacePath?: string, config?: object, port?: number}} [service]
   * @returns {{argv: string[], cwd: string, env: object, port: number}}
   *   argv murni (no shell) — dipakai ProcessManager via child_process.spawn.
   */
  startSpec(service = {}) {
    const workspace = this.assertWorkspace(service);
    const cfg = { ...this.config, ...service?.config };
    const rawDir = cfg.rootDir ?? workspace;
    const targetDir = findIndexHtmlDir(rawDir);
    if (!targetDir) {
      throw new VmPanelError(VALIDATION, 'static adapter requires index.html', { rootDir: rawDir });
    }
    const port = this.requirePort(service);
    return {
      argv: [
        process.execPath,
        STATIC_SERVER_JS,
        '--root',
        String(targetDir),
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
      ],
      cwd: targetDir,
      env: {},
      port,
    };
  }

  /** HTTP check ke root; fallback TCP bila service tanpa port (tidak terjadi di static). */
  healthCheckSpec(service = {}) {
    const cfg = { ...this.config, ...service?.config };
    const port = this.requirePort(service);
    void cfg;
    return { type: 'http', url: `http://127.0.0.1:${port}/`, expectStatus: 200 };
  }

  /** Tidak ada state khusus. */
  async exportState() {
    return {};
  }

  async restoreState() {
    return {};
  }
}
