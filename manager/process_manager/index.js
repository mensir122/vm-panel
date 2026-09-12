// manager/process_manager/index.js — lifecycle proses service (DESIGN.md §6.2-6.4, §6A.2-6A.3, Lampiran A).
// Prinsip: spawn NO-SHELL (execFile-style argv), PID file atomic, env whitelist,
// PID-reuse guard via /proc starttime (Linux), kill-tree via taskkill (Windows).

import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
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

/**
 * #30 — Toleransi pencocokan creation-time proses (ms). Windows: hint ditulis
 * dari clock spawn (fallback "epoch dari clock diff") sedangkan verifikasi lewat
 * CIM punya skew <1s; POSIX: boot epoch dari os.uptime() punya skew kecil.
 */
const PID_REUSE_TOLERANCE_MS = 2000;
/** Cache hasil query creation-time per PID (hindari hammering CIM/powershell). */
const CREATION_CACHE_TTL_MS = 5000;
/** Linux USER_HZ tetap — konversi ticks starttime /proc ke detik. */
const PROC_CLK_TCK = 100;
/** #32 — anak yang exit ≠0 di bawah ambang ini dianggap "gagal segera". */
const FAST_EXIT_MS = 5000;

/**
 * Baca /proc/<pid>/stat field 22 (starttime, sejak boot) — Linux only.
 * @returns {number|null} ticks sejak boot, atau null
 */
function readProcStartTimeTicks(pid) {
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

/**
 * #30 — Creation-time proses anak POSIX dalam epoch ms:
 *   bootEpoch + starttime_ticks / HZ * 1000  (HZ = 100, konstan di Linux).
 * null bila /proc tidak tersedia (macOS dll) → verifikasi dilewati.
 */
function procStartTimeMs(pid) {
  const ticks = readProcStartTimeTicks(pid);
  if (ticks == null) return null;
  const bootMs = Date.now() - os.uptime() * 1000;
  return Math.round(bootMs + (ticks / PROC_CLK_TCK) * 1000);
}

/**
 * #30 — Cache hasil query creation-time Windows per PID. Query CIM berat
 * (±1,4 s proses powershell) dan supervisor polling tiap 5 s → tanpa cache
 * setiap tick memunculkan powershell baru. TTL pendek agar PID-reuse tetap
 * terdeteksi cepat.
 */
const winCreationCache = new Map(); // pid -> { startedAtMs, at }

function buildWinCreationQuery(pid) {
  return (
    "$ErrorActionPreference='SilentlyContinue'; " +
    `$p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}"; ` +
    'if ($p) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }'
  );
}

/**
 * #30 — Creation-time proses Windows (epoch ms) via CIM.
 * @returns {Promise<number|null>} null bila query gagal / proses tak ada
 *   (panggilan wajib memperlakukan null sebagai "tidak bisa diverifikasi").
 */
async function windowsCreationTimeMs(pid, { useCache = true } = {}) {
  if (useCache) {
    const hit = winCreationCache.get(pid);
    if (hit && Date.now() - hit.at <= CREATION_CACHE_TTL_MS) return hit.startedAtMs;
  }
  let ms = null;
  try {
    const { stdout } = await execFileP(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildWinCreationQuery(pid)],
      { timeout: 8000, windowsHide: true },
    );
    const v = Number.parseInt(String(stdout).trim(), 10);
    ms = Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    ms = null; // exec/parse gagal → tidak bisa memverifikasi (BUKAN bukti mati)
  }
  if (ms != null) winCreationCache.set(pid, { startedAtMs: ms, at: Date.now() });
  return ms;
}

/**
 * #30 — Creation-time proses dalam epoch ms, lintas platform.
 * Windows: CIM (async). POSIX: /proc starttime (sinkron). null = tidak
 * dapat diverifikasi (caller TIDAK boleh menyimpulkan proses mati).
 * Di-export agar unit test bisa memperoleh nilai real tanpa menebak.
 */
export async function processCreationTimeMs(pid, { useCache = true } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  return IS_WIN ? windowsCreationTimeMs(n, { useCache }) : procStartTimeMs(n);
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

/**
 * isAlive Windows: tasklist /FI "PID eq X" /FO CSV /NH, parse kolom PID.
 * #30 — bila hint creation-time (epoch ms) diberikan, hasil cocok dengan
 * CreationDate CIM dalam PID_REUSE_TOLERANCE_MS. Mismatch → PID sudah di-reuse
 * proses lain → BUKAN anak kita → dianggap mati (tidak pernah di-kill di sini).
 * Query creation-time gagal → tidak bisa memverifikasi → tetap dianggap hidup
 * (jangan bunuh service hanya karena powershell/CIM tidak tersedia).
 */
async function isAliveWindows(pid, startedAtMsHint = null, { useCache = true } = {}) {
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
  let present = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"')) continue; // baris "INFO: ..." = tidak ada task
    const cols = trimmed.split('","').map((c) => c.replace(/^"|"$/g, ''));
    if (cols[1] === String(pid)) {
      present = true;
      break;
    }
  }
  if (!present) {
    winCreationCache.delete(pid); // PID gone → jangan simpan creation-time basi
    return false;
  }
  if (startedAtMsHint == null) return true;
  const created = await windowsCreationTimeMs(pid, { useCache });
  if (created == null) return true; // tidak terverifikasi → jangan klaim mati
  return Math.abs(created - startedAtMsHint) <= PID_REUSE_TOLERANCE_MS;
}

/**
 * isAlive POSIX: kill(pid,0) + (#30) cocokkan creation-time epoch ms
 * (/proc starttime) terhadap hint. Konsep sama dengan Windows — hint epoch ms.
 * /proc tidak tersedia (macOS) → tidak bisa verifikasi → tetap hidup.
 */
function isAlivePosix(pid, startedAtMsHint = null) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (startedAtMsHint == null) return true;
  const created = procStartTimeMs(pid);
  if (created == null) return true; // tidak terverifikasi → jangan klaim mati
  return Math.abs(created - startedAtMsHint) <= PID_REUSE_TOLERANCE_MS;
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
   *
   * #30 — `startTimeHint` (epoch ms creation-time) ikut dikembalikan supaya
   * pemanggil (ServiceManager) bisa menyimpannya di baris `services` dan
   * memakai isAlive() dengan guard PID-reuse setelah manager restart.
   * Windows: creation-time anak dicatat dari clock spawn (spawn() return SETELAH
   * CreateProcess() → selisihnya ±1 ms; verifikasi nanti pakai CIM).
   * POSIX: /proc/<pid>/stat starttime → epoch ms.
   *
   * @param {{serviceId: string, argv: string[], cwd: string, env?: object,
   *   extraEnv?: object, port?: number|null}} opts
   *   `port` (opsional, #32): port tercatat service — dipakai exit-handler untuk
   *   membedakan crash biasa dari 'port_taken_at_spawn'.
   * @returns {{pid: number, droppedKeys: string[], startTimeHint: number|null}}
   */
  startProcess({ serviceId, argv, cwd, env = {}, extraEnv = {}, port = null }) {
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
      // POSIX: detached = process group sendiri → stopProcess bisa mematikan
      // SELURUH group (npm run start memunculkan child server; membunuh npm
      // saja menyisakan zombie yang masih memegang port). Windows: taskkill
      // /T sudah mematikan tree, detached tidak diperlukan.
      detached: !IS_WIN,
      shell: false,
    });

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const entry = {
      child,
      pid: child.pid,
      argv,
      port: Number.isInteger(port) ? port : null,
      startedAt,
      startedAtMs,
      startTimeHint: IS_WIN ? startedAtMs : procStartTimeMs(child.pid),
      exited: false,
      stoppedByStop: false,
    };
    this.registry.set(serviceId, entry);

    // PID file atomic: "<pid>\n"
    atomicWriteFile(this._pidFile(serviceId), `${child.pid}\n`);

    child.once('exit', (code, signal) => {
      entry.exited = true;
      if (this.registry.get(serviceId) === entry) this.registry.delete(serviceId);
      this._removePidFile(serviceId);
      const stoppedAt = new Date().toISOString();
      const lifetimeMs = Math.max(0, Date.now() - entry.startedAtMs);

      const finalize = (reason) => {
        if (!entry.stoppedByStop) {
          // exit natural/bunuh diri: catat exit record aktual.
          this._writeExitRecord(serviceId, {
            pid: entry.pid,
            argv: entry.argv,
            startedAt: entry.startedAt,
            stoppedAt,
            exitCode: code,
            signal: signal ?? null,
            reason: reason ?? null,
          });
        }
        this._invokeExitHandler(serviceId, {
          pid: entry.pid,
          exitCode: code,
          signal: signal ?? null,
          startedAt: entry.startedAt,
          lifetimeMs,
          port: entry.port,
          reason: reason ?? null,
        });
      };

      // #32 — port-tabrakan-lekas: exit ≠0 dalam <5s pada service berpport →
      // SATU portBindTest. Port terisi → reason 'port_taken_at_spawn' (info
      // tambahan pada alert; kebijakan restart/backoff TIDAK diubah).
      const fastFailWithPort =
        !entry.stoppedByStop &&
        code !== 0 &&
        Number.isInteger(entry.port) &&
        lifetimeMs < FAST_EXIT_MS;
      if (fastFailWithPort) {
        Promise.resolve()
          .then(() => this.portBindTest(entry.port))
          .then((bindable) => finalize(bindable === false ? 'port_taken_at_spawn' : null))
          .catch(() => finalize(null));
        return;
      }
      finalize(null);
    });

    return { pid: child.pid, droppedKeys, startTimeHint: entry.startTimeHint };
  }

  /**
   * Cek proses hidup. POSIX: kill(pid,0) + creation-time match (#30).
   * Windows: tasklist parse kolom PID + (#30) verifikasi CreationDate CIM bila
   * hint diberikan (toleransi 2s). `opts.verifyCreation=false` → lewati
   * verifikasi CIM (dipakai jalur stop: PID sudah pasti anak kita sendiri,
   * dan query CIM ~1s tidak boleh memperlambat polling kematian).
   */
  async isAlive(pid, startTimeHint = null, { verifyCreation = true } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const hint = Number.isFinite(startTimeHint) ? Number(startTimeHint) : null;
    if (IS_WIN) {
      return isAliveWindows(pid, verifyCreation ? hint : null);
    }
    return isAlivePosix(pid, hint);
  }

  /**
   * #30 — Bukti kepemilikan PID: cocokkan creation-time proses yang sekarang
   * memegang PID dengan hint yang kita catat saat spawn (toleransi 2s).
   * @returns {Promise<boolean|null>} true = milik kita, false = PID di-reuse
   *   proses lain, null = tidak bisa diverifikasi (caller jangan menyimpulkan
   *   apa pun — perilakunya sama seperti sebelum guard ini ada).
   */
  async _ownershipMatches(pid, startedAtMsHint) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const hint = Number.isFinite(startedAtMsHint) ? Number(startedAtMsHint) : null;
    if (hint == null) return null;
    if (IS_WIN) {
      const created = await windowsCreationTimeMs(pid);
      if (created == null) return null;
      return Math.abs(created - hint) <= PID_REUSE_TOLERANCE_MS;
    }
    const created = procStartTimeMs(pid);
    if (created == null) return null;
    return Math.abs(created - hint) <= PID_REUSE_TOLERANCE_MS;
  }

  /**
   * Stop service: Windows taskkill /T /F (kill tree); POSIX SIGTERM -> grace ->
   * SIGKILL. Idempotent: service tidak dikenal (registry & PID file kosong) ->
   * {stopped:true, exitCode:null}.
   *
   * #30 — `startTimeHint` (epoch ms creation-time dari baris services) dipakai
   * HANYA untuk jalur PID-file yatim: bila creation-time proses yang memegang
   * PID itu terbukti BEDA dari yang kita catat, PID sudah di-reuse pihak lain →
   * stop menolak membunuh dan mengembalikan {stopped:false, reason:'pid_reuse'}.
   * Untuk anak yang registry-nya pegang sendiri, identitas sudah pasti.
   *
   * @returns {Promise<{stopped: boolean, exitCode: number|null|'killed', reason?: string}>}
   */
  async stopProcess({ serviceId, graceMs = 10000, startTimeHint: hintFromCaller = null }) {
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
      const callerHint = Number.isFinite(hintFromCaller) ? Number(hintFromCaller) : null;
      // #30 — bukti PID di-reuse proses lain → JANGAN bunuh proses asing.
      const ours = await this._ownershipMatches(pid, callerHint);
      if (ours === false) {
        this._removePidFile(serviceId);
        return {
          stopped: false,
          exitCode: null,
          reason: 'pid_reuse_by_other_process',
          pid,
        };
      }
      startTimeHint = callerHint ?? (IS_WIN ? null : procStartTimeMs(pid));
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
      // POSIX: detached spawn = child punya process group sendiri (-pid)
      // → SIGTERM/SIGKILL ke group mematikan npm DAN child server sekaligus.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* sudah mati */
        }
      }
    }

    const dead = await this._waitForDeath(pid, startTimeHint, graceMs);
    if (!dead && !IS_WIN) {
      // POSIX: eskalasi SIGKILL ke process group (detached spawn), fallback
      // direct kill bila group sudah bubar.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* sudah mati */
        }
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
      reason: 'stopped_by_user',
    });
    return { stopped: true, exitCode: 'killed' };
  }

  /**
   * Poll isAlive tiap 200ms sampai mati atau graceMs habis.
   * `verifyCreation: false` — jalur stop sudah tahu PID ini anak yang kita
   * spawn sendiri; verifikasi CIM Windows (~1 s/proses powershell) akan
   * membuat polling jauh lebih lambat daripada graceMs-nya sendiri.
   */
  async _waitForDeath(pid, startTimeHint, graceMs) {
    const deadline = Date.now() + graceMs;
    for (;;) {
      const entry = [...this.registry.values()].find((e) => e.pid === pid);
      if (entry && entry.exited) return true;
      if (!(await this.isAlive(pid, startTimeHint, { verifyCreation: false }))) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
    }
  }

  /**
   * Panggil exit handler ter-isolasi (error handler tidak boleh mengganggu
   * lifecycle) + idempoten per entry.
   * @returns {boolean} true bila handler ada dan dipanggil
   */
  _invokeExitHandler(serviceId, info) {
    if (typeof this._exitHandler !== 'function') return false;
    try {
      this._exitHandler(serviceId, info);
    } catch {
      /* handler user tidak boleh mengganggu lifecycle */
    }
    return true;
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
        port: e.port ?? null,
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
