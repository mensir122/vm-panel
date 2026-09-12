// lib/db.js — wrapper better-sqlite3: open/migrate/integrity/backup/preflight (DESIGN §5.5)
import Database from 'better-sqlite3';
import {
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMAS } from './schema.js';

const SQLITE_MAGIC = 'SQLite format 3\0'; // 16 byte header magic
const BUSY_TIMEOUT_MS = 5000;
/** Umur minimum salinan .tmp sebelum disapu (hindari race dengan writer lain). */
const TMP_SWEEP_OLDER_THAN_MS = 3_600_000; // 1 jam

function nowIso() {
  return new Date().toISOString();
}

/**
 * Pola KETAT salinan yatim hasil preflight sendiri:
 *   `<nama>.(db|db-wal|db-shm).tmp-<digits>`
 * Sengaja tidak menyalip `<db>-wal` / `<db>-shm` aktif (server live memakainya).
 */
const ORPHAN_TMP_RE = /\.(db|db-wal|db-shm)\.tmp-\d+$/;

function isBusyError(e) {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? e ?? '');
  return (
    code.startsWith('SQLITE_BUSY') ||
    code.startsWith('SQLITE_LOCKED') ||
    /database is locked|database table is locked|\bbusy\b/i.test(msg)
  );
}

/**
 * Sapu salinan `.tmp-<digits>` yatim (db / db-wal / db-shm) yang lebih tua dari
 * `olderThanMs` di direktori `dir`. Best-effort: error per-file diabaikan.
 * TIDAK pernah menyentuh `-wal`/`-shm` aktif maupun file DB.
 * @returns {string[]} path file yang berhasil dihapus
 */
export function sweepOrphanTmpFiles(dir, { olderThanMs = TMP_SWEEP_OLDER_THAN_MS, now = Date.now() } = {}) {
  const removed = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return removed; // direktori belum ada / tidak terbaca
  }
  for (const name of entries) {
    if (!ORPHAN_TMP_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < olderThanMs) continue; // masih "baru" — biar
      unlinkSync(full);
      removed.push(full);
    } catch {
      /* hilang di tengah / tidak boleh dihapus — abaikan */
    }
  }
  return removed;
}

function readHeader16(dbPath) {
  const fd = openSync(dbPath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const read = readSync(fd, buf, 0, 16, 0);
    if (read !== 16) return null;
    return buf.toString('latin1');
  } finally {
    closeSync(fd);
  }
}

/**
 * Preflight sebelum open:
 *  (a) file ada tapi 0-byte → throw REFUSE_START_DB (tidak auto-delete)
 *  (b) header != 'SQLite format 3\0' → throw REFUSE_START_DB
 *  (c) sweep salinan `.tmp-<digits>` yatim (usia > 1 jam) di direktori DB.
 *      HANYA pola `*\.(db|db-wal|db-shm)\.tmp-<digits>` — file -wal/-shm AKTIF
 *      tidak pernah disentuh (server live bisa memegangnya).
 *  (d) -wal ada → coba wal_checkpoint(TRUNCATE) via koneksi probe lebih dulu.
 *      Sukses → recovered, TANPA menyimpan salinan. Gagal karena writer aktif
 *      (BUSY) → baru buat salinan WAL/SHM sebagai recovery point (start tidak
 *      diblok, -wal/-shm aktif dibiarkan).
 */
export function preflightCheck(dbPath) {
  const result = { ok: true, walOrphanRecovered: false, backupsMade: [], sweptTmp: [] };

  if (existsSync(dbPath)) {
    const st = statSync(dbPath);
    if (st.size === 0) {
      const err = new Error(
        `DB file exists but is 0-byte (refuse start, not auto-delete): ${dbPath}`,
      );
      err.code = 'REFUSE_START_DB';
      err.reason = 'empty_file';
      throw err;
    }
    const header = readHeader16(dbPath);
    if (header !== SQLITE_MAGIC) {
      const err = new Error(
        `DB file header is not SQLite (refuse start, not auto-delete): ${dbPath}`,
      );
      err.code = 'REFUSE_START_DB';
      err.reason = 'bad_header';
      throw err;
    }

    // (c) bersihkan salinan .tmp yatim dari crash sebelumnya (age > 1 jam).
    result.sweptTmp = sweepOrphanTmpFiles(dirname(dbPath));

    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath)) {
      // koneksi probe: wal_checkpoint(TRUNCATE) butuh write lock — jika
      // writer lain aktif → BUSY → skip (jangan blok start). SQLite menandai
      // checkpoint yang tidak tuntas dengan baris {busy:1}, BUKAN exception.
      let checkpointOk = false;
      let checkpointFailedBusy = false;
      try {
        const probe = new Database(dbPath, { timeout: 500 });
        try {
          const rows = probe.pragma('wal_checkpoint(TRUNCATE)');
          const busy = Array.isArray(rows) && rows[0] ? Number(rows[0].busy) === 1 : false;
          if (busy) checkpointFailedBusy = true;
          else checkpointOk = true;
        } catch (e) {
          checkpointFailedBusy = isBusyError(e);
        } finally {
          try {
            probe.close();
          } catch {
            /* probe sudah tidak terpakai */
          }
        }
      } catch {
        /* probe tidak bisa dibuka — sama sekali jangan blok start */
      }

      if (checkpointOk) {
        result.walOrphanRecovered = true;
      } else {
        // (d) checkpoint tidak berhasil (BUSY writer aktif / probe gagal):
        // salinan HANYA dibuat di sini, sebagai recovery point. Best-effort:
        // di Windows -shm/-wal yang sedang dipegang writer bisa EBUSY — gagal
        // salinan TIDAK boleh memblok start.
        const stamp = Date.now();
        for (const src of [walPath, existsSync(shmPath) ? shmPath : null].filter(Boolean)) {
          const dest = `${src}.tmp-${stamp}`;
          try {
            copyFileSync(src, dest);
            result.backupsMade.push(dest);
          } catch {
            /* terkunci — lewati salinan, file aktif tidak pernah disentuh */
          }
        }
        result.walBusy = checkpointFailedBusy;
      }
    }
  }

  return result;
}

/**
 * Buka DB. PRAGMA wajib: journal_mode=WAL, busy_timeout=5000,
 * foreign_keys=ON. Preflight dijalankan sebelum open.
 */
export function openDatabase(dbPath, { schemaName } = {}) {
  if (!schemaName || !SCHEMAS[schemaName]) {
    const err = new Error(`openDatabase: unknown schemaName '${schemaName}'`);
    err.code = 'UNKNOWN_SCHEMA';
    throw err;
  }

  const preflight = preflightCheck(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma('foreign_keys = ON');

  if (preflight.walOrphanRecovered) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // non-fatal: SQLite menyelesaikan recovery WAL sendiri saat open
    }
  }

  const statements = SCHEMAS[schemaName];

  /** Migrasi idempotent: DDL dalam transaction + catat schema_migrations. */
  function migrate() {
    db.transaction(() => {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        db.exec(stmt.sql);
        const version = i + 1;
        const already = db
          .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
          .get(version);
        if (!already) {
          db.prepare(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          ).run(version, stmt.name, nowIso());
        }
      }
    })();
  }

  /** quick_check + foreign_key_check → {ok, details}. */
  function integrityCheck() {
    const quick = db.pragma('quick_check');
    const fk = db.pragma('foreign_key_check');
    const quickOk = quick.length === 1 && quick[0].quick_check === 'ok';
    const details = { quick_check: quick, foreign_key_check: fk };
    return { ok: quickOk && fk.length === 0, details };
  }

  /** Snapshot transaksional. Target tidak boleh sudah ada (gotcha VACUUM INTO). */
  function vacuumInto(targetPath) {
    if (existsSync(targetPath)) {
      const err = new Error(
        `vacuumInto: target already exists (SQLite VACUUM INTO refuses): ${targetPath}`,
      );
      err.code = 'VACUUM_TARGET_EXISTS';
      throw err;
    }
    const dir = dirname(targetPath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    db.exec(`VACUUM INTO '${String(targetPath).replace(/'/g, "''")}'`);
    return { target: targetPath };
  }

  /** Transaksi BEGIN IMMEDIATE (single-writer discipline §5.5.9). */
  function tx(fn) {
    return db.transaction(fn).immediate();
  }

  function getMeta(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  function setMeta(key, value) {
    db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, String(value), nowIso());
  }

  function checkpoint(mode = 'PASSIVE') {
    const res = db.pragma(`wal_checkpoint(${mode})`);
    return { result: res };
  }

  function close() {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // lanjutkan close
    }
    db.close();
  }

  return {
    db,
    migrate,
    integrityCheck,
    vacuumInto,
    tx,
    getMeta,
    setMeta,
    checkpoint,
    close,
    preflight,
  };
}
