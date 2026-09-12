// lib/lock.js — file lock di runtime/locks/<name>.lock (DESIGN.md §2.5 LockManager).
// Acquire via fs.openSync 'wx' (O_EXCL, atomic di level FS).
// Anti-deadlock §9.1: acquireAll WAJIB sort leksikografis; releaseAll urutan terbalik.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { VmPanelError, LOCK_HELD, VALIDATION } from './errors.js';
import { ensureDir } from './fsutil.js';

const DEFAULTS = Object.freeze({
  ttlMs: 30_000,
  maxWaitMs: 5_000,
  retryMs: 100,
  /** F8: grace window lock tak terbaca/0-byte dianggap HIDUP (pembuat sedang menulis). */
  staleGraceMs: 2_000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * "Umur" file lock = selisih waktu sejak TERAKHIR Kali disentuh (mtime/ctime/
 * birthtime terbesar). Dipakai grace window F8: payload belum terbaca tapi
 * file baru saja ditulis → holder sedang mengisi, bukan stale.
 * @returns {number|null} null bila stat gagal
 */
function fileAgeMs(file, now = Date.now()) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const candidates = [st.mtimeMs, st.ctimeMs, st.birthtimeMs].filter(
    (v) => Number.isFinite(v) && v > 0,
  );
  if (candidates.length === 0) return null;
  return now - Math.max(...candidates);
}

/**
 * F8: perpanjang TTL lock yang SUDAH dimiliki (heartbeat pemegang lock).
 * Hanya pemilik token yang boleh memperpanjang; gagal senyap (false) bila
 * lock hilang / bukan pemilik.
 * @returns {boolean} true bila expiresAt berhasil diperbarui
 */
export function refresh(name, token, opts = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
  if (typeof token !== 'string') return false;
  const dir = opts.dir ?? path.join(process.cwd(), 'runtime', 'locks');
  const file = path.join(dir, `${name}.lock`);
  const { ttlMs } = { ...DEFAULTS, ...opts };
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!info || info.token !== token) return false; // bukan pemilik
  const now = Date.now();
  info.expiresAt = new Date(now + ttlMs).toISOString();
  info.renewedAt = new Date(now).toISOString();
  // nama tmp deterministik per proses → crash saat renew tidak menumpuk sampah
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(info));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    // rename bisa gagal di Windows (destination dipegang pembaca lain) →
    // fallback tulis in-place: payload kecil + grace F8 melindungi pembaca.
    try {
      fs.writeFileSync(file, JSON.stringify(info));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Acquire file lock `<dir>/<name>.lock`.
 * @param {string} name nama lock (tanpa ekstensi), mis. 'backup-global' / 'prj_ABC'
 * @param {{dir?: string, ttlMs?: number, maxWaitMs?: number, retryMs?: number, staleGraceMs?: number}} [opts]
 * @returns {Promise<string>} token — WAJIB dipakai untuk release (pairing)
 */
export async function acquire(name, opts = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new VmPanelError(VALIDATION, `nama lock tidak valid: ${String(name)}`, { name });
  }
  const dir = opts.dir ?? path.join(process.cwd(), 'runtime', 'locks');
  const { ttlMs, maxWaitMs, retryMs, staleGraceMs } = { ...DEFAULTS, ...opts };
  ensureDir(dir);
  const file = path.join(dir, `${name}.lock`);
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    // 1) Coba create-exclusively — satu-satunya cara menang (O_EXCL).
    //    Payload ditulis lewat fd yang sama SEBELUM close: file lock tidak
    //    pernah terlihat ada tanpa isi oleh proses lain (F8).
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
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = null; // hilang / terkunci — dianggap belum terbaca (grace F8)
    }
    let info = null;
    let payloadUnreadable = false;
    if (raw == null) {
      payloadUnreadable = true;
    } else {
      try {
        info = JSON.parse(raw);
      } catch {
        info = null;
        payloadUnreadable = true; // 0-byte / JSON separuh ditulis
      }
    }
    // Terima expiresAt ISO string (format internal) maupun epoch-ms (lock warisan).
    const exp = info?.expiresAt;
    const expiresAtMs =
      typeof exp === 'number' ? exp : typeof exp === 'string' && exp ? Date.parse(exp) : NaN;
    const alive = !!info && Number.isFinite(expiresAtMs) && expiresAtMs >= Date.now();

    // F8: payload belum terbaca (file 0-byte / separuh tulis) DAN file dibuat
    // baru saja (< staleGraceMs) → holder sedang menulis: BUKAN stale.
    // Menghapusnya = TOCTOU yang memecah mutual-exclusion.
    let inGrace = false;
    if (!alive && payloadUnreadable) {
      const age = fileAgeMs(file);
      inGrace = age != null && age < staleGraceMs;
    }

    if (alive || inGrace) {
      // Masih dipegang holder hidup — tunggu sampai deadline.
      if (Date.now() >= deadline) {
        throw new VmPanelError(LOCK_HELD, `timeout menunggu lock '${name}' (${maxWaitMs}ms)`, {
          name,
          waitedMs: maxWaitMs,
          holder: info ? { pid: info.pid, host: info.host } : null,
          graceMs: inGrace ? staleGraceMs : null,
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

/**
 * withLock(name, opts, fn) — acquire, jalankan fn(token), SELALU release.
 * Opsi `heartbeatMs` (F5): selama fn berjalan, TTL lock diperpanjang tiap
 * interval — operasi panjang (deploy: install+build+verify) tidak kehilangan
 * lock padahal holder masih hidup. Interval di-unref agar tidak menahan exit.
 */
export async function withLock(name, opts, fn) {
  if (typeof opts === 'function') {
    fn = opts;
    opts = {};
  }
  const token = await acquire(name, opts);
  const heartbeatMs = Number(opts?.heartbeatMs);
  let timer = null;
  if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
    timer = setInterval(() => {
      try {
        refresh(name, token, opts);
      } catch {
        /* refresh gagal (lock hilang) — jangan jatuhkan operasi */
      }
    }, heartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();
    if (typeof timer.refresh === 'function') timer.refresh();
  }
  try {
    return await fn(token);
  } finally {
    if (timer) clearInterval(timer);
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
