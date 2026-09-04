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
} from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMAS } from './schema.js';

const SQLITE_MAGIC = 'SQLite format 3\0'; // 16 byte header magic
const BUSY_TIMEOUT_MS = 5000;

function nowIso() {
  return new Date().toISOString();
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
 *  (c) -wal yatim (tanpa writer aktif) → backup salinan ke .tmp, lalu
 *      wal_checkpoint(TRUNCATE) via koneksi probe — start tidak diblok.
 *      Jika writer lain aktif, checkpoint gagal BUSY → dibiarkan (try lock).
 */
export function preflightCheck(dbPath) {
  const result = { ok: true, walOrphanRecovered: false, backupsMade: [] };

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

    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath)) {
      // backup salinan (recovery point) sebelum checkpoint mengosongkannya
      const stamp = Date.now();
      copyFileSync(walPath, `${walPath}.tmp-${stamp}`);
      result.backupsMade.push(`${walPath}.tmp-${stamp}`);
      if (existsSync(shmPath)) {
        copyFileSync(shmPath, `${shmPath}.tmp-${stamp}`);
        result.backupsMade.push(`${shmPath}.tmp-${stamp}`);
      }
      // koneksi probe: wal_checkpoint(TRUNCATE) butuh write lock — jika
      // writer lain aktif → BUSY → skip (jangan blok start)
      try {
        const probe = new Database(dbPath, { timeout: 500 });
        try {
          probe.pragma('wal_checkpoint(TRUNCATE)');
          result.walOrphanRecovered = true;
        } finally {
          probe.close();
        }
      } catch {
        // writer aktif atau lock — lanjutkan tanpa memblok start
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
