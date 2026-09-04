// manager/backup_manager/index.js — BackupManager (docs/DESIGN.md §9.1-9.5, D9c).
// FORMAT (D9c): backup = DIREKTORI `backups/<retentionClass>/<backupId>/`
// berisi `manifest.json` + `files/<relpath>.gz` (zlib.gzipSync per file — BUKAN
// tar writer sendiri). Atomicity: seluruh isi ditulis ke
// `backups/.staging-<backupId>/` lalu fs.renameSync ke direktori final; target
// selalu baru karena backupId unik → rename aman (tidak pernah merge/overwrite).
//
// Pemetaan alur 17 langkah §9.1: (1) lock global 'backup-global' (maxWait 5s,
// gagal → BACKUP_IN_PROGRESS) → rate-limit 30 menit §9.5 → per-DB: openDatabase
// + integrityCheck → VACUUM INTO snapshot transaksional (§5.5.3) → close sumber
// → gzip per-file + sha256 (uncompressed) → manifest.json ditulis TERAKHIR
// (keberadaannya menandai staging lengkap) → rename staging→final → INSERT
// backups.db + backup_items → verifyBackup: manifest ada, files exist,
// sha256 cocok (unzip ulang), ukuran > 1KB, minimal platform+projects →
// verification_status 'valid'/'failed'.
//
// DB default: platform/projects/services/deployments/health/backups/locks —
// users & audit sengaja di-skip (panel-owned + append-only sensitif). Satu DB
// gagal (integrity/missing) TIDAK menggagalkan backup penuh — dicatat di
// manifest.dbs + kolom db_status.
//
// Anti-destruktif §9.5/§9.3: rate-limit 30 menit (non-manual), retention
// TIDAK pernah menyentuh 'manual', row retention ditandai 'expired' (bukan
// delete row), dan katalog backups.db milik manager ini dibuka via
// openDatabase (WAL) — snapshot konsisten walau ada writer.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../lib/db.js';
import { withLock } from '../../lib/lock.js';
import { genId } from '../../lib/ids.js';
import { ensureDir, atomicWriteJson, readJson } from '../../lib/fsutil.js';
import {
  VmPanelError,
  BACKUP_IN_PROGRESS,
  NOT_FOUND,
  VALIDATION,
} from '../../lib/errors.js';

const LOCK_NAME = 'backup-global';
const LOCK_MAX_WAIT_MS = 5_000;
const LOCK_TTL_MS = 30_000;
const RATE_LIMIT_MS = 30 * 60 * 1000; // §9.5: min interval backup otomatis
const MIN_TOTAL_BYTES = 1024; // §9.1 langkah 11: ukuran masuk akal (> 1KB)
const RETENTION_CLASSES = Object.freeze(['latest', 'daily', 'weekly', 'manual']);
const TRIGGERS = Object.freeze(['manual', 'scheduled', 'pre-shutdown']);
const DEFAULT_DB_NAMES = Object.freeze([
  'platform',
  'projects',
  'services',
  'deployments',
  'health',
  'backups',
  'locks',
]);
const REQUIRED_DB_FILES = Object.freeze(['files/platform.db.gz', 'files/projects.db.gz']);

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function errMsg(e) {
  return e && typeof e.message === 'string' && e.message.length > 0 ? e.message : String(e);
}

/** 'files/x.db.gz' → path absolut di dalam rootDir (relPath selalu POSIX-style). */
function absFromRel(rootDir, relPath) {
  return path.join(rootDir, ...String(relPath).split('/'));
}

export class BackupManager {
  /**
   * @param {{dataDir: string, backupsRoot: string, lockDir?: string,
   *          retention?: {latest?: number, daily?: number, weekly?: number},
   *          nowFn?: () => number}} opts
   */
  constructor(opts = {}) {
    if (!opts.dataDir) throw new TypeError('BackupManager: dataDir wajib');
    if (!opts.backupsRoot) throw new TypeError('BackupManager: backupsRoot wajib');
    this.dataDir = opts.dataDir;
    this.backupsRoot = opts.backupsRoot;
    this.lockDir = opts.lockDir ?? null;
    this.retention = {
      latest: opts.retention?.latest ?? 3,
      daily: opts.retention?.daily ?? 7,
      weekly: opts.retention?.weekly ?? 4,
    };
    this._now = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();
    this._bk = null; // handle katalog backups.db (lazy)
  }

  /** Handle katalog backups.db (lazy, schema 'backups'). */
  _backupsDb() {
    if (!this._bk) {
      this._bk = openDatabase(path.join(this.dataDir, 'backups.db'), {
        schemaName: 'backups',
      });
      this._bk.migrate();
    }
    return this._bk;
  }

  close() {
    try {
      if (this._bk && this._bk.db.open) this._bk.close();
    } catch {
      /* best-effort */
    }
    this._bk = null;
  }

  /* ------------------------------------------------------------------ */
  /* createBackup                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * @param {{projectId?: string|null,
   *          trigger?: 'manual'|'scheduled'|'pre-shutdown',
   *          retentionClass?: 'latest'|'daily'|'weekly'|'manual',
   *          dbNames?: string[]}} opts
   * @returns {Promise<{backupId: string, path: string, manifest: object}>}
   */
  async createBackup(opts = {}) {
    const projectId = opts.projectId ?? null;
    const trigger = opts.trigger ?? 'manual';
    const retentionClass = opts.retentionClass ?? 'manual';
    const dbNames =
      Array.isArray(opts.dbNames) && opts.dbNames.length > 0
        ? [...new Set(opts.dbNames.map(String))]
        : [...DEFAULT_DB_NAMES];
    if (!TRIGGERS.includes(trigger)) {
      throw new VmPanelError(
        VALIDATION,
        `trigger tidak valid: ${String(trigger)}`,
        { trigger },
      );
    }
    if (!RETENTION_CLASSES.includes(retentionClass)) {
      throw new VmPanelError(
        VALIDATION,
        `retentionClass tidak valid: ${String(retentionClass)}`,
        { retentionClass },
      );
    }

    const lockOpts = {
      dir: this.lockDir ?? undefined,
      ttlMs: LOCK_TTL_MS,
      maxWaitMs: LOCK_MAX_WAIT_MS,
    };
    try {
      return await withLock(LOCK_NAME, lockOpts, () =>
        this._createUnderLock({ projectId, trigger, retentionClass, dbNames }),
      );
    } catch (e) {
      if (e && e.code === 'LOCK_HELD') {
        throw new VmPanelError(
          BACKUP_IN_PROGRESS,
          `backup lain sedang berjalan (lock '${LOCK_NAME}' tidak tersedia)`,
          { lock: LOCK_NAME },
        );
      }
      throw e; // error domain (rate-limit dsb) lewat apa adanya
    }
  }

  /** Body createBackup di dalam lock 'backup-global' (seluruh operasi sync). */
  _createUnderLock({ projectId, trigger, retentionClass, dbNames }) {
    const now = this._now();
    const backupId = genId('bak_');
    const staging = path.join(this.backupsRoot, `.staging-${backupId}`);
    const filesDir = path.join(staging, 'files');
    ensureDir(filesDir);
    try {
      const bk = this._backupsDb();

      // §9.5 rate-limit: backup otomatis (non-manual) ditolak bila backup valid
      // terakhir < 30 menit; trigger 'manual' selalu boleh.
      if (trigger !== 'manual') {
        const last = bk.db
          .prepare(
            `SELECT at FROM backups WHERE verification_status = 'valid'
             ORDER BY at DESC, rowid DESC LIMIT 1`,
          )
          .get();
        const lastMs = last ? Date.parse(last.at) : NaN;
        if (Number.isFinite(lastMs) && now - lastMs < RATE_LIMIT_MS) {
          throw new VmPanelError(
            BACKUP_IN_PROGRESS,
            'rate-limit backup otomatis: backup valid terakhir kurang dari 30 menit lalu',
            { lastAt: last.at, rateLimitMs: RATE_LIMIT_MS },
          );
        }
      }

      const files = [];
      const dbs = {};
      let epoch = null;

      // Per-DB: open → integrity → VACUUM INTO → close → gzip → sha256.
      // DB yang belum ada dibuat on-demand via openDatabase (migrate otomatis)
      // agar backup tidak tergantung urutan inisialisasi manager.
      for (const name of dbNames) {
        const srcPath = path.join(this.dataDir, `${name}.db`);
        let handle = null;
        try {
          handle = openDatabase(srcPath, { schemaName: name });
          handle.migrate(); // idempotent — pastikan schema ada walau DB belum pernah dibuka manager
          const ic = handle.integrityCheck();
          if (!ic.ok) {
            dbs[name] = 'integrity-fail';
            continue; // jangan gagalkan backup penuh untuk satu DB
          }
          if (name === 'platform') epoch = handle.getMeta('backupset_epoch');
          const snapPath = path.join(filesDir, `${name}.db`);
          handle.vacuumInto(snapPath); // snapshot transaksional (§5.5.3)
          handle.close();
          handle = null;
          const raw = fs.readFileSync(snapPath);
          fs.unlinkSync(snapPath);
          const gz = zlib.gzipSync(raw);
          const relPath = `files/${name}.db.gz`;
          fs.writeFileSync(absFromRel(staging, relPath), gz);
          files.push({ relPath, size: raw.length, sha256: sha256Hex(raw) });
          dbs[name] = 'ok';
        } catch (e) {
          try {
            if (handle) handle.close();
          } catch {
            /* ignore */
          }
          dbs[name] = `error: ${errMsg(e)}`;
        }
      }

      // (4) config.yaml non-DB kecil ikut di-backup bila ada.
      const configPath = path.join(this.dataDir, 'config.yaml');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath);
        const gz = zlib.gzipSync(raw);
        const relPath = 'files/config.yaml.gz';
        fs.writeFileSync(absFromRel(staging, relPath), gz);
        files.push({ relPath, size: raw.length, sha256: sha256Hex(raw) });
      }

      // Sanity: minimal platform & projects harus ter-snapshot.
      const haveRequired = REQUIRED_DB_FILES.every((r) =>
        files.some((f) => f.relPath === r),
      );
      if (!haveRequired) {
        throw new VmPanelError(
          VALIDATION,
          'backup tidak lengkap: minimal platform.db dan projects.db wajib ada',
          { dbs },
        );
      }

      const totalSize = files.reduce((a, f) => a + f.size, 0);
      const manifest = {
        version: 1,
        backupId,
        projectId,
        trigger,
        createdAt: new Date(now).toISOString(),
        retentionClass,
        epoch,
        files,
        totalSize,
        totalSha256: sha256Hex(files.map((f) => f.sha256).join('\n')),
        dbs,
        appVersion: process.env.npm_package_version ?? '0.1.0',
      };

      // (5) manifest TERAKHIR (menandai staging lengkap) → (6) rename atomic.
      atomicWriteJson(path.join(staging, 'manifest.json'), manifest);
      const finalPath = path.join(this.backupsRoot, retentionClass, backupId);
      ensureDir(path.dirname(finalPath));
      fs.renameSync(staging, finalPath);

      // (7) INSERT backups.db + backup_items.
      const dbStatus =
        Object.entries(dbs)
          .map(([k, v]) => `${k}=${v}`)
          .join(',') || 'none';
      bk.db
        .prepare(
          `INSERT INTO backups (
             id, project_id, at, trigger, file_path, file_size, sha256,
             db_status, upload_status, verification_status, retention_class,
             runner_id, error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local', 'pending', ?, ?, NULL)`,
        )
        .run(
          backupId,
          projectId,
          manifest.createdAt,
          trigger,
          finalPath,
          totalSize,
          manifest.totalSha256,
          dbStatus,
          retentionClass,
          process.env.RUNNER_ID || 'local',
        );
      const insItem = bk.db.prepare(
        'INSERT INTO backup_items (backup_id, path, size, sha256) VALUES (?, ?, ?, ?)',
      );
      bk.tx(() => {
        for (const f of files) insItem.run(backupId, f.relPath, f.size, f.sha256);
      });

      // Verifikasi pasca-create (langkah 9-15 desain): manifest dibaca ulang,
      // semua file dicek, status row di-update valid/failed. Rate-limit dan
      // retention hanya menghitung backup 'valid', jadi auto-verify di sini.
      const verification = this.verifyBackup(backupId);
      return { backupId, path: finalPath, manifest, verification };
    } catch (e) {
      // Gagal di tengah → bersihkan staging (final rename belum terjadi).
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      throw e;
    }
  }

  /* ------------------------------------------------------------------ */
  /* verifyBackup (langkah 9-15)                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Verifikasi ulang isi direktori backup: manifest ada, semua files exist,
   * per-file sha256 cocok (unzip ulang), totalSize > 1KB, minimal
   * platform.db & projects.db ada. UPDATE verification_status + error.
   * @returns {{ok: boolean, error: string|null}}
   */
  verifyBackup(backupId) {
    const row = this._getBackupRow(backupId); // NOT_FOUND bila tidak ada
    const res = this._verifyPath(row.file_path);
    const bk = this._backupsDb();
    bk.db
      .prepare('UPDATE backups SET verification_status = ?, error = ? WHERE id = ?')
      .run(res.ok ? 'valid' : 'failed', res.error, backupId);
    return res;
  }

  /** Inti verifikasi terhadap sebuah direktori backup (dipakai verify + restore). */
  _verifyPath(dir) {
    let manifest;
    try {
      manifest = readJson(path.join(dir, 'manifest.json'));
    } catch (e) {
      return { ok: false, error: `manifest tidak terbaca: ${errMsg(e)}` };
    }
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) {
      return { ok: false, error: 'manifest tidak valid (version/files)' };
    }
    const rels = new Set(manifest.files.map((f) => f.relPath));
    for (const req of REQUIRED_DB_FILES) {
      if (!rels.has(req)) {
        return { ok: false, error: `file wajib tidak ada di manifest: ${req}` };
      }
    }
    let total = 0;
    for (const f of manifest.files) {
      const abs = absFromRel(dir, f.relPath);
      let gz;
      try {
        gz = fs.readFileSync(abs);
      } catch (e) {
        return { ok: false, error: `file hilang: ${f.relPath} (${errMsg(e)})` };
      }
      let raw;
      try {
        raw = zlib.gunzipSync(gz);
      } catch (e) {
        return { ok: false, error: `gzip corrupt: ${f.relPath} (${errMsg(e)})` };
      }
      const sha = sha256Hex(raw);
      if (sha !== f.sha256) {
        return { ok: false, error: `sha256 mismatch: ${f.relPath}` };
      }
      if (raw.length !== f.size) {
        return { ok: false, error: `size mismatch: ${f.relPath}` };
      }
      total += f.size;
    }
    if (total <= MIN_TOTAL_BYTES) {
      return { ok: false, error: `ukuran backup terlalu kecil (${total} bytes)` };
    }
    if (total !== manifest.totalSize) {
      return { ok: false, error: 'totalSize manifest tidak cocok' };
    }
    return { ok: true, error: null };
  }

  /* ------------------------------------------------------------------ */
  /* applyRetention (§9.3)                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Hapus backup valid MELEBIHI count per kelas (terlama dulu): direktori
   * dihapus, row DITANDAI (bukan delete): verification_status='expired',
   * error='expired by retention'. 'manual' TIDAK pernah disentuh. Backup
   * valid terakhir yang tersisa (satu-satunya) tidak pernah dihapus.
   * @returns {{perClass: {latest: {deleted, kept}, daily: {...}, weekly: {...}}}}
   */
  applyRetention(counts = {}) {
    const latest = counts.latest ?? this.retention.latest;
    const daily = counts.daily ?? this.retention.daily;
    const weekly = counts.weekly ?? this.retention.weekly;
    const bk = this._backupsDb();
    const perClass = {};

    for (const [cls, keep] of [
      ['latest', latest],
      ['daily', daily],
      ['weekly', weekly],
    ]) {
      const rows = bk.db
        .prepare(
          `SELECT id, file_path FROM backups
           WHERE retention_class = ? AND verification_status = 'valid'
           ORDER BY at DESC, rowid DESC`,
        )
        .all(cls);
      // rows[0..keep-1] dipertahankan; sisanya (terlama) dihapus.
      const excess = rows.slice(keep);
      let deleted = 0;
      const detail = [];
      for (const row of excess) {
        try {
          fs.rmSync(row.file_path, { recursive: true, force: true });
        } catch {
          /* direktori mungkin sudah tidak ada — tetap tandai expired */
        }
        bk.db
          .prepare(
            `UPDATE backups SET verification_status = 'expired',
             error = 'expired by retention' WHERE id = ?`,
          )
          .run(row.id);
        deleted += 1;
        detail.push({ id: row.id, action: 'expired' });
      }
      const kept = rows.length - deleted;
      bk.db
        .prepare(
          'INSERT INTO retention_runs (at, class, deleted_count, kept_count, detail) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          new Date(this._now()).toISOString(),
          cls,
          deleted,
          kept,
          JSON.stringify(detail),
        );
      perClass[cls] = { deleted, kept };
    }
    return { perClass };
  }

  /* ------------------------------------------------------------------ */
  /* listBackups / readManifest                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {{retentionClass?: string, limit?: number}} opts
   * @returns {object[]} rows backups.db (terbaru dulu)
   */
  listBackups(opts = {}) {
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
    const bk = this._backupsDb();
    if (opts.retentionClass) {
      return bk.db
        .prepare(
          `SELECT * FROM backups WHERE retention_class = ?
           ORDER BY at DESC, rowid DESC LIMIT ?`,
        )
        .all(String(opts.retentionClass), limit);
    }
    return bk.db
      .prepare('SELECT * FROM backups ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit);
  }

  /** Baca manifest.json sebuah backup berdasarkan id. */
  readManifest(backupId) {
    const row = this._getBackupRow(backupId);
    return readJson(path.join(row.file_path, 'manifest.json'));
  }

  _getBackupRow(backupId) {
    const bk = this._backupsDb();
    const row = bk.db.prepare('SELECT * FROM backups WHERE id = ?').get(String(backupId));
    if (!row) {
      throw new VmPanelError(NOT_FOUND, `backup tidak ditemukan: ${backupId}`, {
        backupId,
      });
    }
    return row;
  }
}

export default BackupManager;
