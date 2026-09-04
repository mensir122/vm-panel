// manager/adapters/node-adapter.js — adapter project Node.js (DESIGN.md §2.6 baris "node").
// install: npm ci --ignore-scripts (pinned lockfile); start: node <main> dengan env PORT.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { VmPanelError, VALIDATION, NOT_FOUND } from '../../lib/errors.js';
import { BaseAdapter } from './base.js';

const INSTALL_TIMEOUT_MS = 120_000; // §desain fase F2
const OUTPUT_LIMIT = 4 * 1024; // output clamp 4KB

/** Jalankan execFile (callback-style) sebagai Promise; err dibawa utuh (stdout/stderr menempel). */
function runExecFile(ef, file, args, opts) {
  return new Promise((resolve, reject) => {
    try {
      ef(file, args, opts, (err, stdout, stderr) => {
        if (err) {
          err.stdout = err.stdout ?? stdout ?? '';
          err.stderr = err.stderr ?? stderr ?? '';
          reject(err);
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

function clampOutput(str) {
  const s = String(str ?? '');
  return s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) : s;
}

function readPackageJson(workspace) {
  const pkgPath = path.join(workspace, 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch (e) {
    throw new VmPanelError(NOT_FOUND, 'package.json tidak ditemukan', {
      path: pkgPath,
      cause: String(e?.message ?? e),
    });
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    throw new VmPanelError(VALIDATION, 'package.json korup (bukan JSON valid)', {
      path: pkgPath,
      cause: String(e?.message ?? e),
    });
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new VmPanelError(VALIDATION, 'package.json korup (bukan objek)', { path: pkgPath });
  }
  return pkg;
}

export class NodeAdapter extends BaseAdapter {
  /** @param {{workspacePath?: string, config?: object}} [opts] */
  constructor(opts = {}) {
    super({ name: 'node', ...opts });
    /** @type {object|null} hasil parse package.json (diisi validate) */
    this.pkg = null;
  }

  /** True jika workspace berisi package.json. */
  detect(ctx = {}) {
    const ws = ctx?.workspacePath ?? this.workspacePath;
    if (!ws) return false;
    try {
      return fs.statSync(path.join(ws, 'package.json')).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Parse package.json (VALIDATION jika korup); wajib ada main atau scripts.start.
   * @returns {{ok: true, main: string|null, hasStart: boolean}}
   */
  validate(config = {}) {
    const cfg = { ...this.config, ...config };
    const workspace = cfg.workspacePath ?? this.workspacePath;
    if (!workspace || !fs.existsSync(workspace)) {
      throw new VmPanelError(NOT_FOUND, 'workspace tidak ditemukan', { workspacePath: workspace ?? null });
    }
    const pkg = readPackageJson(workspace);
    const hasMain = typeof pkg.main === 'string' && pkg.main.trim() !== '';
    const hasStart =
      pkg.scripts && typeof pkg.scripts === 'object' &&
      typeof pkg.scripts.start === 'string' && pkg.scripts.start.trim() !== '';
    if (!hasMain && !hasStart) {
      throw new VmPanelError(VALIDATION, 'node adapter requires main atau scripts.start', {
        workspacePath: workspace,
      });
    }
    this.pkg = pkg;
    return { ok: true, main: hasMain ? pkg.main : null, hasStart };
  }

  /** Port default dari config.port (fallback 3000). */
  configure(ctx = {}) {
    const cfg = { ...this.config, ...(ctx?.config ?? ctx ?? {}) };
    this.config = cfg;
    const port = Number(cfg.port);
    this.port = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3000;
    return { ok: true, port: this.port };
  }

  /**
   * Instalasi dependency: `npm ci --ignore-scripts` di workspace, timeout 120s.
   * Executable: win32 → 'npm.cmd', selain itu 'npm'.
   * @param {object} [ctx]
   * @param {{execFile?: Function}} [deps] injeksi eksekutor untuk testability
   * @returns {Promise<{ok: boolean, output: string}>} output di-clamp 4KB
   */
  async install(ctx = {}, deps = {}) {
    const workspace = this.assertWorkspace(ctx);
    const ef = deps.execFile ?? execFile;
    const exe = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const opts = { cwd: workspace, timeout: INSTALL_TIMEOUT_MS, windowsHide: true };
    let output = '';
    try {
      const { stdout, stderr } = await runExecFile(ef, exe, ['ci', '--ignore-scripts'], opts);
      output = String(stdout) + String(stderr);
      return { ok: true, output: clampOutput(output) };
    } catch (e) {
      output = String(e?.stdout ?? '') + String(e?.stderr ?? '') + String(e?.message ?? '');
      return { ok: false, output: clampOutput(output) };
    }
  }

  /**
   * @param {{workspacePath?: string, config?: object, port?: number}} [service]
   * @returns {{argv: string[], cwd: string, env: object, port: number}}
   */
  startSpec(service = {}) {
    const workspace = this.assertWorkspace(service);
    const cfg = { ...this.config, ...service?.config };
    const main = cfg.main ?? this.pkg?.main;
    if (!main) {
      throw new VmPanelError(VALIDATION, 'node adapter requires main (package.json "main")', {
        workspacePath: workspace,
      });
    }
    const port = this.requirePort(service);
    return {
      argv: [process.execPath, path.resolve(workspace, main)],
      cwd: workspace,
      env: { PORT: String(port) },
      port,
    };
  }

  /** config.healthCheck apa adanya (objek) atau default TCP ke port service. */
  healthCheckSpec(service = {}) {
    const cfg = { ...this.config, ...service?.config };
    if (cfg.healthCheck && typeof cfg.healthCheck === 'object') {
      return cfg.healthCheck;
    }
    const port = this.requirePort(service);
    return { type: 'tcp', port };
  }
}
