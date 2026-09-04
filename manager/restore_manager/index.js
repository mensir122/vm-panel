// manager/restore_manager/index.js — RestoreManager (docs/DESIGN.md §5.5, §9.5).
// TIDAK ADA auto-restore: semua restore adalah panggilan eksplisit (panel/CLI
// yang di-wire di wave berikutnya). TIDAK me-restart manager (pemanggil yang
// handle).
//
// Alur restoreBackup(backupId, {dryRun}):
//  (1) read manifest + verifyBackup ulang (verification failed → VALIDATION
//      'backup not verified');
//  (2) ekstrak per-DB ke `dataDir/.restore-staging-<token>/`: unzip →
//      pre-flight ala lib/db.js (0-byte/header → VALIDATION 'restored file
//      corrupt') → buka staging DB → integrityCheck → close. Satu DB gagal →
//      skip + warning, JANGAN batalkan semua;
//  (3) dryRun=true → berhenti di sini dengan laporan (DB asli tidak disentuh);
//  (4) atomic swap per DB: rename DB lama → `<name>.db.pre-restore-<token>`
//      (rollback point, JANGAN dihapus) → rename staging → final;
//  (5) return {restored, skipped, warnings, rollbackDir}.
//
// Pre-restore marker (§8.6 restore journal, MINIMAL): sebelum ekstraksi,
// `.restore-marker.json` (dataDir) ditulis berisi token aktif; dihapus saat
// restore sukses/dryRun selesai. Restore berikutnya yang menemukan marker
// lama (process mati di tengah restore) membersihkan staging lama +
// rollback point orphan token tsb, lalu menjalankan restore penuh ulang —
// idempotent, aman di-restart berkali-kali. Snapshot asli di backups/ tidak
// pernah disentuh (anti-destruktif §9.5).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDatabase } from '../../lib/db.js';
import { randomToken } from '../../lib/crypto.js';
import { atomicWriteJson, ensureDir } from '../../lib/fsutil.js';
import { VmPanelError, NOT_FOUND, VALIDATION } from '../../lib/errors.js';

const SQLITE_MAGIC = 'SQLite format 3\0'; // sama dengan lib/db.js

function errMsg(e) {
  return e && typeof e.message === 'string' && e.message.length > 0 ? e.message : String(e);
}

/**
 * Rename dengan retry kecil: di Windows, file yang BARU ditulis/ditutup
 * kadang sesaat masih dipegang antivirus/indexer (EBUSY transient). Swap
 * restore harus deterministik → coba ulang beberapa kali dengan backoff.
 */
function renameWithRetry(src, dest, { attempts = 5, delayMs = 120 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (e) {
      lastErr = e;
      const busy = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
      if (!busy || i === attempts - 1) break;
      const wait = delayMs * (i + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  throw lastErr;
}

export class RestoreManager {
  /**
   * @param {{dataDir: string, backupsRoot: string,
   *          backupManager: import('../backup_manager/index.js').BackupManager}} opts
   */
  constructor(opts = {}) {
    if (!opts.dataDir) throw new TypeError('RestoreManager: dataDir wajib');
    if (!opts.backupsRoot) throw new TypeError('RestoreManager: backupsRoot wajib');
    if (!opts.backupManager) throw new TypeError('RestoreManager: backupManager wajib');
    this.dataDir = opts.dataDir;
    this.backupsRoot = opts.backupsRoot;
    this.backupManager = opts.backupManager;
  }

  /**
   * @param {string} backupId
   * @param {{dryRun?: boolean}} opts
   * @returns {{restored: string[], skipped: string[], warnings: string[],
   *            rollbackDir: string|null, dryRun: boolean}}
   */
  restoreBackup(backupId, opts = {}) {
    const dryRun = opts.dryRun === true;

    // (1) manifest + verifikasi ulang. Row backup harus ada; direktori
    // di-resolve dari row (bukan dipercaya dari manifest).
    let row = null;
    try {
      row = this.backupManager._getBackupRow(backupId);
    } catch (e) {
      if (e && e.code === NOT_FOUND) throw e;
      throw e;
    }
    const dir = row.file_path;
    let manifest;
    try {
      manifest = this.backupManager.readManifest(backupId);
    } catch (e) {
      throw new VmPanelError(
        NOT_FOUND,
        `manifest backup tidak terbaca: ${errMsg(e)}`,
        { backupId },
      );
    }
    const verified = this.backupManager._verifyPath(dir);
    if (!verified.ok) {
      throw new VmPanelError(VALIDATION, `backup not verified: ${verified.error}`, {
        backupId,
        verification: 'failed',
      });
    }

    // (2) staging ekstraksi + pre-flight per DB.
    // Marker idempotent-retry (§8.6 restore journal): sebelum swap apa pun,
    // tulis pre-restore marker (intent log) berisi token aktif. Restore
    // berikutnya (process mati di tengah swap) mendeteksi marker lama →
    // bersihkan staging lama + rollback point orphan → lanjut dengan token baru.
    const restored = [];
    const skipped = [];
    const warnings = [];
    let rollbackDir = null;
    const token = randomToken(8);
    const staging = path.join(this.dataDir, `.restore-staging-${token}`);
    ensureDir(staging);
    const markerPath = this._markerPath();
    const prevMarker = this._readMarker(markerPath);
    if (prevMarker && prevMarker.token && prevMarker.token !== token) {
      const prev = String(prevMarker.token);
      // Staging lama (isi parsial) + rollback point orphan dari run yang mati
      // di tengah → buang (bukan data valid: snapshot asli tetap ada di
      // backups/<class>/<id>/ — anti-destruktif §9.5 tetap terjaga).
      try {
        fs.rmSync(path.join(this.dataDir, `.restore-staging-${prev}`), {
          recursive: true,
          force: true,
        });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(path.join(this.dataDir, `.restore-rollback-${prev}`), {
          recursive: true,
          force: true,
        });
      } catch {
        /* best-effort */
      }
      warnings.push(`pre-restore marker dari run sebelumnya dibersihkan (token ${prev})`);
    }
    this._writeMarker(markerPath, { token, backupId, at: new Date().toISOString() });

    try {
      const dbEntries = manifest.files.filter((f) => f.relPath.startsWith('files/') && f.relPath.endsWith('.db.gz'));
      for (const entry of dbEntries) {
        const dbName = path.basename(entry.relPath).replace(/\.db\.gz$/, '');
        const stagingDb = path.join(staging, `${dbName}.db`);
        try {
          const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, ...entry.relPath.split('/'))));

          // Pre-flight ala lib/db.js: 0-byte / header salah → corrupt.
          if (raw.length === 0) {
            throw new VmPanelError(VALIDATION, 'restored file corrupt: 0-byte', { db: dbName });
          }
          if (raw.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
            throw new VmPanelError(VALIDATION, 'restored file corrupt: bad header', { db: dbName });
          }
          fs.writeFileSync(stagingDb, raw);

          // Buka staging DB + integrityCheck → close.
          const handle = openDatabase(stagingDb, { schemaName: dbName });
          try {
            const ic = handle.integrityCheck();
            if (!ic.ok) {
              throw new VmPanelError(
                VALIDATION,
                `restored file corrupt: integrity_check gagal (${dbName})`,
                { db: dbName },
              );
            }
          } finally {
            handle.close();
          }
          restored.push(dbName);
        } catch (e) {
          // Satu DB gagal → skip + warning, JANGAN batalkan semua.
          try {
            if (fs.existsSync(stagingDb)) fs.unlinkSync(stagingDb);
          } catch {
            /* best-effort */
          }
          skipped.push(dbName);
          warnings.push(`skip ${dbName}: ${errMsg(e)}`);
        }
      }
    } catch (e) {
      // Kegagalan di luar per-DB (mis. staging tak bisa ditulis) → bersihkan.
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      throw e;
    }

    // (3) dryRun → berhenti dengan laporan; DB asli tidak disentuh; marker
    // dihapus (tidak ada intent tertunda).
    if (dryRun) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      this._clearMarker(markerPath);
      return { restored, skipped, warnings, rollbackDir: null, dryRun: true };
    }

    // (4) atomic swap per DB: rename lama → .pre-restore-<token>, staging → final.
    // Tutup dulu handle katalog yang mungkin terbuka (backups.db ikut
    // di-swap; handle terbuka → rename EBUSY di Windows). Katalog dibuka
    // ulang secara lazy pada pemakaian berikutnya.
    try {
      this.backupManager.close?.();
    } catch {
      /* best-effort */
    }
    rollbackDir = path.join(this.dataDir, `.restore-rollback-${token}`);
    ensureDir(rollbackDir);
    for (const dbName of restored) {
      const finalDb = path.join(this.dataDir, `${dbName}.db`);
      const stagingDb = path.join(staging, `${dbName}.db`);
      if (fs.existsSync(finalDb)) {
        // Rollback point — JANGAN dihapus (anti-destruktif §9.5).
        renameWithRetry(finalDb, path.join(rollbackDir, `${dbName}.db.pre-restore-${token}`));
      }
      // Sidecar WAL/SHM milik DB LAMA ikut dipindah (jangan ditinggal — WAL
      // yatim bisa menimpa isi DB baru saat dibuka berikutnya).
      for (const suffix of ['-wal', '-shm']) {
        const side = finalDb + suffix;
        if (fs.existsSync(side)) {
          renameWithRetry(side, path.join(rollbackDir, `${dbName}.db${suffix}.pre-restore-${token}`));
        }
      }
      renameWithRetry(stagingDb, finalDb);
    }

    // Bersihkan staging (isi sudah dipindah; DB gagal skip sudah dihapus).
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }

    // Restore sukses → intent selesai, marker dihapus.
    this._clearMarker(markerPath);

    // (5) laporan. NB: test "file .pre-restore ada" — rollbackDir memuat
    // `<name>.db.pre-restore-<token>`.
    return { restored, skipped, warnings, rollbackDir, dryRun: false };
  }

  /* ---------------- pre-restore marker (§8.6 idempotent retry) ---------------- */

  /** Path marker: dataDir/.restore-marker.json (satu intent aktif per dataDir). */
  _markerPath() {
    return path.join(this.dataDir, '.restore-marker.json');
  }

  /** Baca marker; korup/tidak ada → null (tidak pernah throw). */
  _readMarker(markerPath = this._markerPath()) {
    try {
      const raw = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      return raw && typeof raw === 'object' && raw.token ? raw : null;
    } catch {
      return null;
    }
  }

  _writeMarker(markerPath, obj) {
    atomicWriteJson(markerPath, obj);
  }

  /** Hapus marker (best-effort; ENOENT diabaikan). */
  _clearMarker(markerPath = this._markerPath()) {
    try {
      fs.unlinkSync(markerPath);
    } catch {
      /* sudah tidak ada */
    }
  }
}

export default RestoreManager;
