// manager/adapters/python-adapter.js — adapter project Python (DESIGN.md §2.6 baris "python").
// install: venv per project + pip install -r requirements.txt (jika ada); start: venv python main.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { VmPanelError, VALIDATION } from '../../lib/errors.js';
import { BaseAdapter } from './base.js';

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

export class PythonAdapter extends BaseAdapter {
  /** @param {{workspacePath?: string, config?: object}} [opts] */
  constructor(opts = {}) {
    super({ name: 'python', ...opts });
  }

  /** Path python yang dipakai untuk membuat venv. */
  pythonBin(config = {}) {
    const cfg = { ...this.config, ...config };
    if (typeof cfg.pythonBin === 'string' && cfg.pythonBin.trim() !== '') {
      return cfg.pythonBin;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  /** Path interpreter python di dalam venv (sesuai platform). */
  venvPythonPath(workspace) {
    return process.platform === 'win32'
      ? path.join(workspace, '.venv', 'Scripts', 'python.exe')
      : path.join(workspace, '.venv', 'bin', 'python');
  }

  /** Path pip di dalam venv (sesuai platform). */
  venvPipPath(workspace) {
    return process.platform === 'win32'
      ? path.join(workspace, '.venv', 'Scripts', 'pip.exe')
      : path.join(workspace, '.venv', 'bin', 'pip');
  }

  /** True jika ada requirements.txt atau entry *.py kandidat (main.py / app.py / config.main). */
  detect(ctx = {}) {
    const ws = ctx?.workspacePath ?? this.workspacePath;
    if (!ws) return false;
    try {
      if (fs.statSync(path.join(ws, 'requirements.txt')).isFile()) return true;
    } catch {
      /* lanjut cek entry */
    }
    const cfg = this.config ?? {};
    const candidates = ['main.py', 'app.py'];
    if (typeof cfg.main === 'string' && cfg.main.trim() !== '') candidates.push(cfg.main);
    return candidates.some((rel) => {
      try {
        return fs.statSync(path.join(ws, rel)).isFile();
      } catch {
        return false;
      }
    });
  }

  /**
   * config.main wajib (entry script yang dijalankan venv python).
   * @returns {{ok: true, main: string, pythonBin: string, hasRequirements: boolean}}
   */
  validate(config = {}) {
    const cfg = { ...this.config, ...config };
    const workspace = cfg.workspacePath ?? this.workspacePath;
    if (!workspace || !fs.existsSync(workspace)) {
      throw new VmPanelError(NOT_FOUND, 'workspace tidak ditemukan', { workspacePath: workspace ?? null });
    }
    const main = cfg.main;
    if (typeof main !== 'string' || main.trim() === '') {
      throw new VmPanelError(VALIDATION, 'python adapter requires config.main', { workspacePath: workspace });
    }
    const hasRequirements = fs.existsSync(path.join(workspace, 'requirements.txt'));
    return { ok: true, main, pythonBin: this.pythonBin(cfg), hasRequirements };
  }

  /** Tidak ada langkah build; venv dibuat di install(). */
  async prepare() {
    return { ok: true };
  }

  /**
   * Instalasi: [pythonBin, -m, venv, .venv] lalu (jika ada requirements.txt)
   * [venvPip, install, -r, requirements.txt]. Python tidak ada di PATH →
   * VALIDATION 'python not found' (tidak crash).
   * @param {object} [ctx]
   * @param {{execFile?: Function}} [deps] injeksi eksekutor untuk testability
   * @returns {Promise<{ok: boolean, steps: string[], output: string}>}
   */
  async install(ctx = {}, deps = {}) {
    const workspace = this.assertWorkspace(ctx);
    const cfg = { ...this.config, ...(ctx?.config ?? {}) };
    const ef = deps.execFile ?? execFile;
    const pythonBin = this.pythonBin(cfg);
    const venvPath = path.join(workspace, '.venv');
    const steps = [];
    const outputs = [];
    const opts = { cwd: workspace, windowsHide: true };

    // Fase 1: buat venv. ENOENT / spawn-fail pada pythonBin → VALIDATION 'python not found'.
    steps.push(`venv:${pythonBin}`);
    try {
      const { stdout, stderr } = await runExecFile(
        ef, pythonBin, ['-m', 'venv', venvPath], opts,
      );
      outputs.push(String(stdout), String(stderr));
    } catch (e) {
      const cause = String(e?.code ?? e?.message ?? e);
      if (e && (e.code === 'ENOENT' || e.code === 'ENOACTIVE' || /ENOENT|not found|not recognized/i.test(String(e?.message)))) {
        throw new VmPanelError(VALIDATION, 'python not found', {
          pythonBin, cause,
        });
      }
      outputs.push(String(e?.stdout ?? ''), String(e?.stderr ?? ''), String(e?.message ?? ''));
      return { ok: false, steps, output: clampOutput(outputs.join('\n')) };
    }

    // Fase 2: pip install -r requirements.txt (skip bila tidak ada).
    const reqPath = path.join(workspace, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      const venvPip = this.venvPipPath(workspace);
      steps.push(`pip:${venvPip}`);
      try {
        const { stdout, stderr } = await runExecFile(
          ef, venvPip, ['install', '-r', reqPath], opts,
        );
        outputs.push(String(stdout), String(stderr));
      } catch (e) {
        outputs.push(String(e?.stdout ?? ''), String(e?.stderr ?? ''), String(e?.message ?? ''));
        return { ok: false, steps, output: clampOutput(outputs.join('\n')) };
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
    const main = cfg.main;
    if (typeof main !== 'string' || main.trim() === '') {
      throw new VmPanelError(VALIDATION, 'python adapter requires config.main', { workspacePath: workspace });
    }
    const port = this.requirePort(service);
    return {
      argv: [this.venvPythonPath(workspace), path.resolve(workspace, main)],
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
