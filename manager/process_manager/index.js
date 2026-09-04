// manager/process_manager/index.js — lifecycle proses service (DESIGN.md §6.2-6.4, §6A.2-6A.3, Lampiran A).
// Prinsip: spawn NO-SHELL (execFile-style argv), PID file atomic, env whitelist,
// PID-reuse guard via /proc starttime (Linux), kill-tree via taskkill (Windows).

import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { VmPanelError, VALIDATION, NOT_FOUND, PORT_ILLEGAL } from '../../lib/errors.js';
import { atomicWriteFile, readJson, ensureDir } from '../../lib/fsutil.js';

const IS_WIN = process.platform === 'win32';

/** Daftar nama var env global yang boleh diteruskan ke child process (§6A.3). */
const ENV_WHITELIST_EXACT = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'LANG', 'TZ',
  'TMPDIR', 'TEMP', 'TMP',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'NODE_ENV',
]);

/** Var env yang eksplisit DILARANG lewat meskipun berpola whitelist. */
const ENV_FORBIDDEN = new Set(['NODE_OPTIONS']);

/**
 * Filter process.env ke whitelist global.
 * @returns {{env: Record<string,string>, droppedKeys: string[]}}
 *   droppedKeys = semua var yang dibuang (termasuk NODE_OPTIONS).
 */
export function whitelistGlobalEnv(rawEnv) {
  const env = {};
  const droppedKeys = [];
  for (const [key, value] of Object.entries(rawEnv ?? {})) {
    const upper = key.toUpperCase();
    const allowed =
      ENV_WHITELIST_EXACT.has(upper) ||
      (upper.startsWith('LC_') && !ENV_FORBIDDEN.has(upper));
    if (allowed) env[key] = value;
    else droppedKeys.push(key);
  }
  return { env, droppedKeys };
}

/** Baca /proc/<pid>/stat field 22 (starttime, sejak boot) — Linux only. */
function readProcStartTime(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) bisa berisi spasi/parens -> parse setelah ')' terakhir.
    const close = raw.lastIndexOf(')');
    const fields = raw.slice(close + 2).split(' ');
    // fields[0] = state (field 3); starttime = field 22 => index 22-3 = 19.
    const v = Number.parseInt(fields[19], 10);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** execFile yang di-promise; resolve {stdout, stderr} atau reject dengan error. */
function execFileP(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** isAlive Windows: tasklist /FI "PID eq X" /FO CSV /NH, parse kolom PID. */
async function isAliveWindows(pid) {
  let stdout;
  try {
    ({ stdout } = await execFileP(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { timeout: 3000, windowsHide: true },
    ));
  } catch {
    return false; // parse/exec gagal -> false (fail-closed)
  }
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"')) continue; // baris "INFO: ..." = tidak ada task
    const cols = trimmed.split('","').map((c) => c.replace(/^"|"$/g, ''));
    if (cols[1] === String(pid)) return true;
  }
  return false;
}

/** isAlive POSIX: kill(pid,0) + cocokkan /proc starttime bila hint ada. */
function isAlivePosix(pid, startTimeHint) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (startTimeHint != null) {
    const now = readProcStartTime(pid);
    if (now !== startTimeHint) return false; // PID reuse
  }
  return true;
}

/**
 * ProcessManager — spawn/stop/status proses service di rootDir.
 * Dir artefak: runtime/pid/<serviceId>.pid, runtime/processes/<serviceId>.json.
 */
export class ProcessManager {
  /** @param {{rootDir: string}} opts */
  constructor({ rootDir }) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'ProcessManager: rootDir wajib');
    }
    this.rootDir = path.resolve(rootDir);
    this.pidDir = path.join(this.rootDir, 'runtime', 'pid');
    this.exitDir = path.join(this.rootDir, 'runtime', 'processes');
    ensureDir(this.pidDir);
    ensureDir(this.exitDir);
    /** serviceId -> {child, pid, argv, startedAt, startTimeHint, exited, stoppedByStop} */
    this.registry = new Map();
    /** callback opsional: onExit(serviceId, info) */
    this._exitHandler = null;
  }

  /** Pasang callback exit: fn(serviceId, {pid, exitCode, signal, startedAt}). */
  setExitHandler(fn) {
    this._exitHandler = typeof fn === 'function' ? fn : null;
  }

  _pidFile(serviceId) {
    return path.join(this.pidDir, `${serviceId}.pid`);
  }

  _exitFile(serviceId) {
    return path.join(this.exitDir, `${serviceId}.json`);
  }

  /**
   * Spawn proses service. NO SHELL. env = whitelist(global) + extraEnv + env
   * (env paling akhir, menang atas extraEnv).
   * @returns {{pid: number, droppedKeys: string[]}}
   */
  startProcess({ serviceId, argv, cwd, env = {}, extraEnv = {} }) {
    if (!serviceId || typeof serviceId !== 'string') {
      throw new VmPanelError(VALIDATION, 'serviceId wajib string non-kosong', { serviceId });
    }
    if (this.registry.has(serviceId)) {
      throw new VmPanelError(VALIDATION, `service sudah berjalan: ${serviceId}`, { serviceId });
    }
    if (
      !Array.isArray(argv) || argv.length === 0 ||
      !argv.every((a) => typeof a === 'string' && a.length > 0)
    ) {
      throw new VmPanelError(VALIDATION, 'argv wajib array non-kosong berisi string', { serviceId });
    }
    let cwdStat;
    try {
      cwdStat = fs.statSync(cwd);
    } catch {
      throw new VmPanelError(NOT_FOUND, `cwd tidak ada: ${cwd}`, { serviceId, cwd });
    }
    if (!cwdStat.isDirectory()) {
      throw new VmPanelError(NOT_FOUND, `cwd bukan direktori: ${cwd}`, { serviceId, cwd });
    }

    const { env: whitelisted, droppedKeys } = whitelistGlobalEnv(process.env);
    const finalEnv = { ...whitelisted, ...extraEnv, ...env };

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: finalEnv,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      detached: false,
      shell: false,
    });

    const startedAt = new Date().toISOString();
    const entry = {
      child,
      pid: child.pid,
      argv,
      startedAt,
      startTimeHint: IS_WIN ? null : readProcStartTime(child.pid),
      exited: false,
      stoppedByStop: false,
    };
    this.registry.set(serviceId, entry);

    // PID file atomic: "<pid>\n"
    atomicWriteFile(this._pidFile(serviceId), `${child.pid}\n`);

    child.once('exit', (code, signal) => {
      entry.exited = true;
      if (this.registry.get(serviceId) === entry) this.registry.delete(serviceId);
      if (!entry.stoppedByStop) {
        // exit natural/bunuh diri: catat exit record aktual.
        this._writeExitRecord(serviceId, {
          pid: entry.pid,
          argv: entry.argv,
          startedAt: entry.startedAt,
          stoppedAt: new Date().toISOString(),
          exitCode: code,
          signal: signal ?? null,
        });
      }
      this._removePidFile(serviceId);
      if (this._exitHandler) {
        try {
          this._exitHandler(serviceId, {
            pid: entry.pid,
            exitCode: code,
            signal: signal ?? null,
            startedAt: entry.startedAt,
          });
        } catch {
          /* handler user tidak boleh mengganggu lifecycle */
        }
      }
    });

    return { pid: child.pid, droppedKeys };
  }

  /**
   * Cek proses hidup. Linux: kill(pid,0) + starttime match (PID-reuse guard).
   * Windows: tasklist parse kolom PID. Hasil parse gagal -> false.
   */
  async isAlive(pid, startTimeHint = null) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (IS_WIN) return isAliveWindows(pid);
    return isAlivePosix(pid, startTimeHint);
  }

  /**
   * Stop service: Windows taskkill /T /F (kill tree); POSIX SIGTERM -> grace ->
   * SIGKILL. Idempotent: service tidak dikenal (registry & PID file kosong) ->
   * {stopped:true, exitCode:null}.
   * @returns {{stopped: true, exitCode: number|null|'killed'}}
   */
  async stopProcess({ serviceId, graceMs = 10000 }) {
    if (!serviceId || typeof serviceId !== 'string') {
      throw new VmPanelError(VALIDATION, 'serviceId wajib string non-kosong', { serviceId });
    }
    const entry = this.registry.get(serviceId) ?? null;

    let pid;
    let startTimeHint;
    if (entry) {
      pid = entry.pid;
      startTimeHint = entry.startTimeHint;
      entry.stoppedByStop = true; // exit listener tidak menulis record 'natural'
    } else {
      // Manager restart / proses yatim: coba PID file.
      let raw = null;
      try {
        raw = fs.readFileSync(this._pidFile(serviceId), 'utf8');
      } catch {
        return { stopped: true, exitCode: null }; // already-stopped
      }
      pid = Number.parseInt(raw.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        this._removePidFile(serviceId);
        return { stopped: true, exitCode: null };
      }
      startTimeHint = IS_WIN ? null : readProcStartTime(pid);
    }

    if (IS_WIN) {
      try {
        await execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 3000,
          windowsHide: true,
        });
      } catch {
        /* sudah mati / sudah tidak ada -> poll di bawah yang memutuskan */
      }
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* sudah mati */
      }
    }

    const dead = await this._waitForDeath(pid, startTimeHint, graceMs);
    if (!dead && !IS_WIN) {
      // POSIX: eskalasi SIGKILL lalu tunggu sekali lagi.
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* sudah mati */
      }
      const deadAfterKill = await this._waitForDeath(pid, startTimeHint, graceMs);
      if (!deadAfterKill) {
        throw new VmPanelError(VALIDATION, 'process refuses to die', { serviceId, pid });
      }
    } else if (!dead) {
      throw new VmPanelError(VALIDATION, 'process refuses to die', { serviceId, pid });
    }

    this.registry.delete(serviceId);
    this._removePidFile(serviceId);
    this._writeExitRecord(serviceId, {
      pid,
      argv: entry ? entry.argv : null,
      startedAt: entry ? entry.startedAt : null,
      stoppedAt: new Date().toISOString(),
      exitCode: 'killed',
      signal: IS_WIN ? null : 'SIGKILL',
    });
    return { stopped: true, exitCode: 'killed' };
  }

  /** Poll isAlive tiap 200ms sampai mati atau graceMs habis. */
  async _waitForDeath(pid, startTimeHint, graceMs) {
    const deadline = Date.now() + graceMs;
    for (;;) {
      const entry = [...this.registry.values()].find((e) => e.pid === pid);
      if (entry && entry.exited) return true;
      if (!(await this.isAlive(pid, startTimeHint))) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
    }
  }

  _removePidFile(serviceId) {
    try {
      fs.unlinkSync(this._pidFile(serviceId));
    } catch {
      /* sudah tidak ada */
    }
  }

  _writeExitRecord(serviceId, record) {
    atomicWriteFile(this._exitFile(serviceId), JSON.stringify(record, null, 2) + '\n');
  }

  /** Snapshot registry (tanpa objek child). */
  listProcesses() {
    const out = [];
    for (const [serviceId, e] of this.registry.entries()) {
      out.push({
        serviceId,
        pid: e.pid,
        argv: e.argv,
        startedAt: e.startedAt,
        startTimeHint: e.startTimeHint,
      });
    }
    return out;
  }

  /** Exit record terakhir service, atau null bila belum pernah keluar. */
  getExitRecord(serviceId) {
    try {
      return readJson(this._exitFile(serviceId));
    } catch (e) {
      if (e && e.code === NOT_FOUND) return null;
      throw e;
    }
  }

  /**
   * Validasi port legal (§6A.2): integer dalam [min,max] (default 10000-65535),
   * tidak termasuk reserved.
   */
  assertPortLegal(port, { reserved = [], min = 10000, max = 65535 } = {}) {
    const reject = (why) => {
      throw new VmPanelError(PORT_ILLEGAL, `port tidak legal: ${why}`, { port, min, max });
    };
    if (!Number.isInteger(port)) reject('bukan integer');
    if (port < min) reject(`di bawah minimum ${min}`);
    if (port > max) reject(`di atas maximum ${max}`);
    if (reserved.includes(port)) reject('port reserved');
    return port;
  }

  /**
   * Bind-test port di 127.0.0.1: buka listener lalu close.
   * @returns {Promise<boolean>} true bila port bisa di-bind sekarang.
   */
  portBindTest(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => {
        try { srv.close(); } catch { /* noop */ }
        resolve(false);
      });
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(true));
      });
    });
  }
}

export default ProcessManager;
