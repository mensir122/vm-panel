// lib/lock.js — file lock di runtime/locks/<name>.lock (DESIGN.md §2.5 LockManager).
// Acquire via fs.openSync 'wx' (O_EXCL, atomic di level FS).
// Anti-deadlock §9.1: acquireAll WAJIB sort leksikografis; releaseAll urutan terbalik.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { VmPanelError, LOCK_HELD, VALIDATION } from './errors.js';
import { ensureDir } from './fsutil.js';

const DEFAULTS = Object.freeze({ ttlMs: 30_000, maxWaitMs: 5_000, retryMs: 100 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire file lock `<dir>/<name>.lock`.
 * @param {string} name nama lock (tanpa ekstensi), mis. 'backup-global' / 'prj_ABC'
 * @param {{dir?: string, ttlMs?: number, maxWaitMs?: number, retryMs?: number}} [opts]
 * @returns {Promise<string>} token — WAJIB dipakai untuk release (pairing)
 */
export async function acquire(name, opts = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new VmPanelError(VALIDATION, `nama lock tidak valid: ${String(name)}`, { name });
  }
  const dir = opts.dir ?? path.join(process.cwd(), 'runtime', 'locks');
  const { ttlMs, maxWaitMs, retryMs } = { ...DEFAULTS, ...opts };
  ensureDir(dir);
  const file = path.join(dir, `${name}.lock`);
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    // 1) Coba create-exclusively — satu-satunya cara menang (O_EXCL).
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        const now = Date.now();
        const payload = {
          pid: process.pid,
          host: os.hostname(),
          token,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttlMs).toISOString(),
        };
        fs.writeFileSync(fd, JSON.stringify(payload));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }

    // 2) Lock ada — cek stale (expired / korup / tidak terbaca).
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      info = null;
    }
    // Terima expiresAt ISO string (format internal) maupun epoch-ms (lock warisan).
    const exp = info?.expiresAt;
    const expiresAtMs =
      typeof exp === 'number' ? exp : typeof exp === 'string' && exp ? Date.parse(exp) : NaN;
    const alive = !!info && Number.isFinite(expiresAtMs) && expiresAtMs >= Date.now();

    if (alive) {
      // Masih dipegang holder hidup — tunggu sampai deadline.
      if (Date.now() >= deadline) {
        throw new VmPanelError(LOCK_HELD, `timeout menunggu lock '${name}' (${maxWaitMs}ms)`, {
          name,
          waitedMs: maxWaitMs,
          holder: { pid: info.pid, host: info.host },
        });
      }
      await sleep(retryMs);
      continue;
    }

    // 3) Stale takeover: hapus lock kadaluarsa/korup, catat event, coba lagi.
    try {
      fs.unlinkSync(file);
    } catch {
      /* pemilik lain lebih dulu menghapus/merebut */
    }
    try {
      fs.appendFileSync(
        path.join(dir, 'stale-takeover.log'),
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'stale_takeover',
          name,
          pid: process.pid,
          previous: info ? { pid: info.pid, host: info.host, expiredAt: info.expiresAt } : null,
        }) + '\n',
      );
    } catch {
      /* logging best-effort */
    }
  }
}

/**
 * Release lock hanya jika token cocok — hanya pemilik boleh menghapus.
 * Return true bila terlepas; false bila lock tidak ada / bukan pemilik.
 */
export function release(name, token, opts = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
  const dir = opts.dir ?? path.join(process.cwd(), 'runtime', 'locks');
  const file = path.join(dir, `${name}.lock`);
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // lock sudah tidak ada / tidak terbaca -> nothing to release
  }
  if (!info || typeof token !== 'string' || info.token !== token) return false; // bukan pemilik
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** withLock(name, opts, fn) — acquire, jalankan fn(token), SELALU release. */
export async function withLock(name, opts, fn) {
  if (typeof opts === 'function') {
    fn = opts;
    opts = {};
  }
  const token = await acquire(name, opts);
  try {
    return await fn(token);
  } finally {
    release(name, token, opts);
  }
}

/**
 * Acquire banyak lock — urutan WAJIB leksikografis (anti-deadlock §9.1;
 * global lock seperti 'backup-global' memang sort paling depan).
 * Return { acquired: [{name, token}] }; gagal di tengah -> release yang
 * sudah didapat, lalu rethrow.
 */
export async function acquireAll(names, opts = {}) {
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const acquired = [];
  try {
    for (const n of sorted) acquired.push({ name: n, token: await acquire(n, opts) });
    return { acquired };
  } catch (e) {
    releaseAll(acquired, opts);
    throw e;
  }
}

/** Release kumpulan lock dalam urutan TERBALIK dari akuisisi (§9.1). */
export function releaseAll(acquired, opts = {}) {
  const list = Array.isArray(acquired) ? acquired : acquired?.acquired ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item && typeof item === 'object' && 'name' in item) {
      release(item.name, item.token, opts);
    }
  }
}
