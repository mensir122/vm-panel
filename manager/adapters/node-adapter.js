// manager/adapters/node-adapter.js — adapter project Node.js (DESIGN.md §2.6 baris "node").
// install: lockfile ada → npm ci --ignore-scripts (pinned); TANPA lockfile →
// npm install --no-audit --no-fund; lalu npm run build bila scripts.build ada
// (Next.js-style, env NEXT_TELEMETRY_DISABLED=1, timeout 15 menit, output clamp).
// start: node <main> ATAU — bila tanpa main — `npm run start` (scripts.start),
// keduanya dengan env PORT (npm path + NEXT_TELEMETRY_DISABLED=1).

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { VmPanelError, VALIDATION, NOT_FOUND } from '../../lib/errors.js';
import { BaseAdapter } from './base.js';

const INSTALL_TIMEOUT_MS = 120_000; // 2 menit default; dapat dioverride via config.installTimeoutMs
const BUILD_TIMEOUT_MS = 15 * 60_000; // build Next.js bisa 3-8 menit (budget 15)
const OUTPUT_LIMIT = 4 * 1024; // output clamp 4KB

/** npm executable sesuai platform (win32 → npm.cmd). */
function npmExe() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * argv npm run <script> untuk ProcessManager spawn NO-SHELL:
 * - POSIX: ['npm', ...] (spawn script shebang aman; sesuai kontrak adapter).
 * - win32: [node, npm-cli.js, ...] — spawn 'npm.cmd' tanpa shell = EINVAL
 *   (Node >= 20.12); node + npm-cli.js di samping process.execPath tetap
 *   no-shell murni. npm-cli.js tidak ditemukan → VALIDATION.
 */
function npmRunArgv(args) {
  if (process.platform !== 'win32') {
    return ['npm', ...args];
  }
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) {
    throw new VmPanelError(VALIDATION, 'npm-cli.js tidak ditemukan (instalasi Node tidak lengkap)', {
      npmCli,
    });
  }
  return [process.execPath, npmCli, ...args];
}

/** True jika workspace berisi package-lock.json (menentukan npm ci vs npm install). */
function hasLockfile(workspace) {
  try {
    return fs.statSync(path.join(workspace, 'package-lock.json')).isFile();
  } catch {
    return false;
  }
}

/** True jika pkg.scripts[name] string non-kosong. */
function hasScript(pkg, name) {
  const s = pkg?.scripts;
  return !!(s && typeof s === 'object' && typeof s[name] === 'string' && s[name].trim() !== '');
}

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
    const hasStart = hasScript(pkg, 'start');
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
   * Instalasi dependency + build:
   * - package-lock.json ADA → `npm ci --ignore-scripts` (pinned, perilaku lama).
   * - TANPA lockfile → `npm install --no-audit --no-fund` (repo Next.js-style).
   * - package.json punya scripts.build → `npm run build` setelah install
   *   (env NEXT_TELEMETRY_DISABLED=1, timeout 15 menit; gagal → install gagal
   *   dengan pesan jelas).
   * Executable: win32 → 'npm.cmd' (via shell — Node >= 20.12 menolak spawn
   * .cmd tanpa shell; argumen statis jadi aman), selain itu 'npm'.
   * @param {object} [ctx]
   * @param {{execFile?: Function}} [deps] injeksi eksekutor untuk testability
   * @returns {Promise<{ok: boolean, steps: string[], output: string}>} output di-clamp 4KB
   */
  async install(ctx = {}, deps = {}) {
    const workspace = this.assertWorkspace(ctx);
    const ef = deps.execFile ?? execFile;
    const exe = npmExe();
    const baseOpts = {
      cwd: workspace,
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
      ...(process.platform === 'win32' ? { shell: true } : {}),
    };

    const useCi = hasLockfile(workspace);
    const installArgs = useCi
      ? ['ci', '--ignore-scripts']
      : ['install', '--no-audit', '--no-fund'];
    const steps = [`install:${useCi ? 'ci' : 'install'}`];
    const outputs = [];
    try {
      const { stdout, stderr } = await runExecFile(ef, exe, installArgs, baseOpts);
      outputs.push(String(stdout), String(stderr));
    } catch (e) {
      const output = String(e?.stdout ?? '') + String(e?.stderr ?? '') + String(e?.message ?? '');
      return { ok: false, steps, output: clampOutput(output) };
    }

    // Build (opsional): scripts.build ada → npm run build SEBELUM service start.
    let pkg = null;
    try {
      pkg = readPackageJson(workspace);
    } catch {
      pkg = null; // package.json korup/hilang — install sudah jalan, biarkan start/validate yang melapor
    }
    if (hasScript(pkg, 'build')) {
      steps.push('build');
      const buildOpts = {
        ...baseOpts,
        timeout: BUILD_TIMEOUT_MS,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      };
      try {
        const { stdout, stderr } = await runExecFile(ef, exe, ['run', 'build'], buildOpts);
        outputs.push(String(stdout), String(stderr));
      } catch (e) {
        const output =
          `npm run build gagal: ${String(e?.message ?? e)}\n` +
          String(e?.stdout ?? '') +
          String(e?.stderr ?? '');
        return { ok: false, steps, output: clampOutput(output) };
      }
    }

    return { ok: true, steps, output: clampOutput(outputs.join('\n')) };
  }

  /**
   * @param {{workspacePath?: string, config?: object, port?: number}} [service]
   * @returns {{argv: string[], cwd: string, env: object, port: number}}
   */
  startSpec(service = {}) {
    const workspace = this.assertWorkspace(service);
    const cfg = { ...this.config, ...service?.config };
    const port = this.requirePort(service);

    // Jalur npm (Next.js-style): flag eksplisit config.npmStart menang atas
    // cfg.main — main stale dari revision lama tidak boleh dipakai.
    if (cfg.npmStart !== true) {
      const main = cfg.main ?? this.pkg?.main;
      if (typeof main === 'string' && main.trim() !== '') {
        return {
          argv: [process.execPath, path.resolve(workspace, main)],
          cwd: workspace,
          env: { PORT: String(port) },
          port,
        };
      }
    }

    // Tanpa cfg.main/pkg.main: baca package.json workspace — main ada → jalur
    // node <main> (tahan banting bila service config tidak membawa main);
    // scripts.start ada → `npm run start`; keduanya tidak ada → VALIDATION.
    let pkg = this.pkg;
    if (!pkg) {
      try {
        pkg = readPackageJson(workspace);
      } catch {
        pkg = null;
      }
    }
    const wsMain = typeof pkg?.main === 'string' && pkg.main.trim() !== '' ? pkg.main : null;
    if (wsMain) {
      return {
        argv: [process.execPath, path.resolve(workspace, wsMain)],
        cwd: workspace,
        env: { PORT: String(port) },
        port,
      };
    }
    if (!hasScript(pkg, 'start')) {
      throw new VmPanelError(
        VALIDATION,
        'node adapter requires main (package.json "main") atau scripts.start',
        { workspacePath: workspace },
      );
    }
    return {
      argv: npmRunArgv(['run', 'start']),
      cwd: workspace,
      env: {
        PORT: String(port),
        NEXT_TELEMETRY_DISABLED: '1',
        DATA_DIR: path.join(workspace, 'data-dir'),
        APPDATA: path.join(workspace, 'data-dir'),
      },
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
