// manager/import_manager/index.js — ImportManager (docs/DESIGN.md §10.2, 15 langkah).
//
// Menerima container .vpe dari ExportManager (magic 'VPEXPORT1' plaintext /
// 'VPEXPORT1E' AES-256-GCM PBKDF2 salt 'export' 600k — lihat export_manager).
//
// Alur desain (langkah desain → implementasi):
//   1-5  inspectImport()   : decompress → magic/password → manifest → checksum
//                            per-file sha256 → registry → ringkasan + warnings
//                            (TANPA menulis apa pun ke disk).
//   6-7  preflight         : whitelist prefix ('db/', 'registry/'), whitelist
//                            nama DB, tolak absolut/`..`/backslash. Catatan:
//                            langkah desain "executable check" tidak relevan
//                            untuk container JSON-b64 (tidak ada bit exec;
//                            file dikontrol whitelist ketat) — digantikan
//                            whitelist nama file (unexpected entry → VALIDATION).
//   8-11 two-phase import : confirmImport() → {confirmToken, expectedPhrase:'IMPORT'}
//                            (TTL 10 menit, in-memory, one-shot) →
//                            importAll({confirmToken, expectedToken:'IMPORT'}).
//                            Eksekusi atomik: rollback point (.pre-import-<token>/,
//                            TIDAK dihapus otomatis) → preflight DB bytes → swap.
//
// Gagal preflight DB payload (bukan SQLite/corrupt) → DB itu di-SKIP + warning,
// DB lokal TIDAK disentuh. DB tampered/unknown setelah lolos checksum → VALIDATION.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { openDatabase } from '../../lib/db.js';
import { aesDecrypt, deriveKey, randomToken } from '../../lib/crypto.js';
import { VmPanelError, VALIDATION, NOT_FOUND, PERMISSION_DENIED } from '../../lib/errors.js';
import { atomicWriteFile } from '../../lib/fsutil.js';

const MAGIC_PLAIN = 'VPEXPORT1';
const MAGIC_ENCRYPTED = 'VPEXPORT1E';
const EXPORT_VERSION = 1;
const PBKDF2_SALT = 'export';
const PBKDF2_PURPOSE = 'export';
const PBKDF2_ITERATIONS = 600000;
const SQLITE_MAGIC = 'SQLite format 3\0';

/** Whitelist prefix payload (langkah 6-7). */
const ALLOWED_PREFIXES = Object.freeze(['db/', 'registry/']);
/** Whitelist nama file DB (hanya 7 nama sah — 6 core + audit opsional). */
const ALLOWED_DB_FILES = Object.freeze([
  'platform.db',
  'projects.db',
  'services.db',
  'deployments.db',
  'health.db',
  'backups.db',
  'audit.db',
]);
const REGISTRY_FILE = 'registry/export-registry.json';
const CONFIRM_PHRASE = 'IMPORT';
const TOKEN_TTL_MS = 10 * 60 * 1000;

function validationError(message, details) {
  return new VmPanelError(VALIDATION, message, details);
}

function permissionError(message, details) {
  return new VmPanelError(PERMISSION_DENIED, message, details);
}

/** Decompress + decrypt + parse container. Tanpa efek samping disk. */
function readContainer(inputPath, password) {
  let gz;
  try {
    gz = fs.readFileSync(inputPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new VmPanelError(NOT_FOUND, `file export tidak ditemukan: ${inputPath}`, {
        inputPath,
      });
    }
    throw e;
  }
  let json;
  try {
    json = zlib.gunzipSync(gz).toString('utf8');
  } catch {
    throw validationError('decompress failed: file bukan gzip .vpe yang valid', {
      inputPath,
    });
  }
  let root;
  try {
    root = JSON.parse(json);
  } catch {
    throw validationError('container JSON invalid', { inputPath });
  }
  if (!root || typeof root !== 'object' || typeof root.magic !== 'string') {
    throw validationError('container invalid: magic tidak ada', { inputPath });
  }

  if (root.magic === MAGIC_ENCRYPTED) {
    if (!password) {
      throw validationError('export terenkripsi — password wajib', { encrypted: true });
    }
    const env = root.envelope;
    if (!env || typeof env !== 'object' || !env.iv || !env.tag || !env.ct) {
      throw validationError('envelope enkripsi invalid', { inputPath });
    }
    const key = deriveKey(password, PBKDF2_SALT, PBKDF2_PURPOSE);
    let inner;
    try {
      inner = aesDecrypt(key, env); // tag mismatch → DECRYPT_FAIL
    } catch {
      throw validationError('decrypt failed (password salah atau file tampered)', {
        inputPath,
        reason: 'decrypt failed',
      });
    }
    try {
      root = JSON.parse(inner);
    } catch {
      throw validationError('decrypted container JSON invalid', { inputPath });
    }
    if (!root || typeof root !== 'object' || root.magic !== MAGIC_PLAIN) {
      throw validationError('container inner invalid: magic tidak cocok', { inputPath });
    }
    return root;
  }

  if (root.magic === MAGIC_PLAIN) return root;
  throw validationError(`magic tidak dikenal: ${root.magic}`, { inputPath, magic: root.magic });
}

/** Validasi manifest + schema files[] + checksum per-file sha256. */
function verifyManifestAndChecksums(container, inputPath) {
  const manifest = container.manifest;
  if (!manifest || typeof manifest !== 'object') {
    throw validationError('manifest tidak ada', { inputPath });
  }
  if (manifest.version !== EXPORT_VERSION) {
    throw validationError(`manifest.version tidak didukung: ${String(manifest.version)}`, {
      inputPath,
      version: manifest.version,
    });
  }
  if (manifest.scope !== 'all' && manifest.scope !== 'project') {
    throw validationError(`manifest.scope invalid: ${String(manifest.scope)}`, {
      inputPath,
      scope: manifest.scope,
    });
  }
  if (!Array.isArray(manifest.files)) {
    throw validationError('manifest.files bukan array', { inputPath });
  }
  const payload = container.payload;
  if (!payload || typeof payload !== 'object') {
    throw validationError('payload tidak ada', { inputPath });
  }
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string') {
      throw validationError('manifest.files entry invalid', { inputPath });
    }
    const item = payload[entry.path];
    if (!item || typeof item.b64 !== 'string') {
      throw validationError(`checksum mismatch: payload '${entry.path}' tidak ada`, {
        inputPath,
        path: entry.path,
      });
    }
    const bytes = Buffer.from(item.b64, 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.sha256) {
      throw validationError(`checksum mismatch: ${entry.path}`, {
        inputPath,
        path: entry.path,
        expected: entry.sha256,
        actual: sha256,
      });
    }
  }
  return manifest;
}

/**
 * Safety preflight (langkah 6-7): validasi SELURUH relpath payload.
 * Tolak absolut, `..`, backslash, prefix di luar whitelist, nama DB di luar
 * whitelist → VALIDATION 'unexpected entry'. executable check tidak relevan
 * untuk container JSON (lihat header file).
 */
function preflightPaths(payload) {
  const relpaths = Object.keys(payload);
  for (const rel of relpaths) {
    if (typeof rel !== 'string' || rel.length === 0) {
      throw validationError('unexpected entry: relpath kosong', { path: String(rel) });
    }
    if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel) || /^\\\\/.test(rel)) {
      throw validationError(`unexpected entry: absolute path ditolak — ${rel}`, { path: rel });
    }
    if (rel.includes('\\')) {
      throw validationError(`unexpected entry: backslash ditolak (relpath wajib POSIX) — ${rel}`, {
        path: rel,
      });
    }
    for (const seg of rel.split('/')) {
      if (seg === '..') {
        throw validationError(`unexpected entry: traversal '..' ditolak — ${rel}`, { path: rel });
      }
    }
    const okPrefix = ALLOWED_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
    if (!okPrefix) {
      throw validationError(`unexpected entry: prefix di luar whitelist — ${rel}`, {
        path: rel,
        allowed: ALLOWED_PREFIXES,
      });
    }
    if (rel.startsWith('db/')) {
      const name = rel.slice('db/'.length);
      if (!ALLOWED_DB_FILES.includes(name)) {
        throw validationError(`unexpected entry: nama DB tidak sah — ${rel}`, {
          path: rel,
          allowed: ALLOWED_DB_FILES,
        });
      }
    } else if (rel !== REGISTRY_FILE) {
      throw validationError(`unexpected entry: file registry tidak sah — ${rel}`, {
        path: rel,
        allowed: [REGISTRY_FILE],
      });
    }
  }
  return relpaths.sort();
}

/** Ringkasan registry + warnings bentrok dengan projects.db lokal. */
function summarizeRegistry(registry, localProjectsDbPath) {
  const warnings = [];
  const projects = Array.isArray(registry?.projects) ? registry.projects : [];
  const services = Array.isArray(registry?.services) ? registry.services : [];
  let localIds = new Set();
  if (fs.existsSync(localProjectsDbPath)) {
    const handle = openDatabase(localProjectsDbPath, { schemaName: 'projects' });
    try {
      localIds = new Set(handle.db.prepare('SELECT id FROM projects').all().map((r) => r.id));
    } finally {
      handle.close();
    }
  }
  const projectSummaries = projects.map((p) => {
    if (p.id && localIds.has(p.id)) warnings.push(`will be replaced: project '${p.id}' sudah ada di projects.db lokal`);
    return { id: p.id ?? null, name: p.name ?? null, type: p.type ?? null };
  });
  return { projects: projectSummaries, servicesCount: services.length, warnings };
}

/**
 * ImportManager — pembaca + pengeksekusi file .vpe dengan two-phase confirm.
 */
export class ImportManager {
  /** @param {{dataDir: string}} opts — folder berisi *.db manager lokal. */
  constructor({ dataDir } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw validationError('ImportManager: dataDir wajib', { field: 'dataDir' });
    }
    this.dataDir = path.resolve(dataDir);
    this.projectsDbPath = path.join(this.dataDir, 'projects.db');
    fs.mkdirSync(this.dataDir, { recursive: true });
    /** Map token → {expiresAt, inputPath, summary} (in-memory, TTL 10 menit). */
    this._pending = new Map();
  }

  // -----------------------------------------------------------------------
  // Inspect (tanpa menulis)
  // -----------------------------------------------------------------------

  /**
   * Langkah 1-5 desain: ringkasan import TANPA menulis ke disk.
   * @returns {{magic, scope, encrypted, createdAt, appVersion, projectIds,
   *            projects:[{id,name,type}], servicesCount, files:[{path,size}],
   *            warnings:[string]}}
   */
  inspectImport({ inputPath, password } = {}) {
    if (!inputPath || typeof inputPath !== 'string') {
      throw validationError('inspectImport: inputPath wajib', { field: 'inputPath' });
    }
    const container = readContainer(inputPath, password);
    // Path safety (langkah 6-7) DINILAI DULU sebelum checksum — menolak entry
    // di luar whitelist lebih awal (fail-closed).
    preflightPaths(container.payload);
    const manifest = verifyManifestAndChecksums(container, inputPath);

    const registryEntry = container.payload[REGISTRY_FILE];
    let registry = null;
    if (registryEntry) {
      try {
        registry = JSON.parse(Buffer.from(registryEntry.b64, 'base64').toString('utf8'));
      } catch {
        throw validationError('export-registry.json invalid (bukan JSON)', { inputPath });
      }
    }
    const { projects, servicesCount, warnings } = registry
      ? summarizeRegistry(registry, this.projectsDbPath)
      : { projects: [], servicesCount: 0, warnings: ['registry tidak ada di payload'] };

    return {
      magic: manifest.encrypted ? MAGIC_ENCRYPTED : MAGIC_PLAIN,
      scope: manifest.scope,
      encrypted: !!manifest.encrypted,
      createdAt: manifest.createdAt ?? null,
      appVersion: manifest.appVersion ?? null,
      projectIds: Array.isArray(manifest.projectIds) ? manifest.projectIds : [],
      projects,
      servicesCount,
      files: manifest.files.map((f) => ({ path: f.path, size: f.size })),
      warnings,
    };
  }

  // -----------------------------------------------------------------------
  // Two-phase confirm
  // -----------------------------------------------------------------------

  /**
   * Fase 1: buat token konfirmasi (randomToken 16 byte, TTL 10 menit, one-shot).
   * @returns {{confirmToken: string, expectedPhrase: 'IMPORT', summary: object}}
   */
  confirmImport({ inputPath, password } = {}) {
    const summary = this.inspectImport({ inputPath, password });
    const token = randomToken(16); // 32-char hex
    this._pending.set(token, {
      expiresAt: Date.now() + TOKEN_TTL_MS,
      inputPath,
      summary,
    });
    return { confirmToken: token, expectedPhrase: CONFIRM_PHRASE, summary };
  }

  _consumeToken(confirmToken, expectedToken) {
    if (typeof expectedToken !== 'string' || expectedToken !== CONFIRM_PHRASE) {
      throw permissionError('expectedToken tidak cocok (wajib "IMPORT")', {
        expectedPhrase: CONFIRM_PHRASE,
      });
    }
    if (!confirmToken || typeof confirmToken !== 'string') {
      throw permissionError('confirmToken wajib (fase 1 confirmImport dulu)', {});
    }
    const entry = this._pending.get(confirmToken);
    this._pending.delete(confirmToken); // one-shot: konsumsi di awal
    if (!entry) {
      throw permissionError('confirmToken tidak dikenal / sudah dipakai / kedaluwarsa', {
        confirmToken,
      });
    }
    if (Date.now() > entry.expiresAt) {
      throw permissionError('confirmToken kedaluwarsa (TTL 10 menit) — confirm ulang', {
        confirmToken,
      });
    }
    return entry;
  }

  // -----------------------------------------------------------------------
  // Eksekusi import (atomik, langkah 8-11)
  // -----------------------------------------------------------------------

  /**
   * Rollback point: VACUUM INTO tiap DB lokal ke dataDir/.pre-import-<token>/.
   * TIDAK dihapus otomatis — milik operator.
   */
  _createRollbackPoint(token) {
    const dir = path.join(this.dataDir, `.pre-import-${token}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ALLOWED_DB_FILES) {
      const src = path.join(this.dataDir, file);
      if (!fs.existsSync(src)) continue;
      const schema = file === 'audit.db' ? 'audit' : file.replace(/\.db$/, '');
      const handle = openDatabase(src, { schemaName: schema });
      try {
        handle.vacuumInto(path.join(dir, file));
      } finally {
        handle.close();
      }
    }
    return dir;
  }

  /**
   * Preflight DB payload sebelum swap: header SQLite + open file tmp +
   * integrity_check. Return {ok, error?}.
   */
  _preflightRestoredDb(dbFile, bytes, stagingDir) {
    const tmp = path.join(stagingDir, `pf-${randomToken(6)}-${dbFile}`);
    try {
      fs.writeFileSync(tmp, bytes);
      if (bytes.length < 16 || bytes.toString('latin1', 0, 16) !== SQLITE_MAGIC) {
        return { ok: false, error: 'bukan file SQLite (header mismatch)' };
      }
      const probe = new Database(tmp, { readonly: true });
      try {
        const rows = probe.pragma('integrity_check');
        const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
        return ok ? { ok: true } : { ok: false, error: `integrity_check: ${rows[0]?.integrity_check ?? 'unknown'}` };
      } finally {
        probe.close();
      }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* abaikan */
      }
    }
  }

  /**
   * Fase 2: eksekusi import atomik (langkah 8-11). Wajib {confirmToken,
   * expectedToken:'IMPORT'} dari confirmImport() — mismatch/expired →
   * PERMISSION_DENIED.
   *
   * Per-DB: gagal preflight → DB itu di-SKIP + warning; DB lokal tidak disentuh.
   * DB tampered/unknown nama yang lolos jalur lain → VALIDATION.
   *
   * @returns {{restored: string[], skipped: [{file, reason}], warnings: string[],
   *            rollbackPoint: string, summary: object}}
   */
  importAll({ inputPath, password, confirmToken, expectedToken, actor } = {}) {
    void actor; // audit ops menyusul (wave wire-up); tidak menulis di fase ini
    const entry = this._consumeToken(confirmToken, expectedToken);
    if (inputPath && inputPath !== entry.inputPath) {
      throw validationError('inputPath berbeda dari yang dikonfirmasi', {
        confirmed: entry.inputPath,
        given: inputPath,
      });
    }
    const inputPathFinal = entry.inputPath;

    const container = readContainer(inputPathFinal, password);
    const manifest = verifyManifestAndChecksums(container, inputPathFinal);
    const relpaths = preflightPaths(container.payload);

    const rollbackPoint = this._createRollbackPoint(randomToken(8));

    const restored = [];
    const skipped = [];
    const warnings = [];
    const stagingDir = path.join(this.dataDir, `.import-staging-${randomToken(8)}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
      for (const rel of relpaths) {
        if (rel === REGISTRY_FILE) continue; // registry = sumber ringkasan, bukan target swap
        const dbFile = rel.slice('db/'.length);
        const bytes = Buffer.from(container.payload[rel].b64, 'base64');
        const pf = this._preflightRestoredDb(dbFile, bytes, stagingDir);
        if (!pf.ok) {
          warnings.push(`skip ${dbFile}: preflight gagal (${pf.error}) — DB lokal tidak disentuh`);
          skipped.push({ file: dbFile, reason: pf.error });
          continue;
        }
        const target = path.join(this.dataDir, dbFile);
        // Atomic swap (langkah 11): tulis tmp + fsync + rename di direktori yang
        // sama (atomicWriteFile) → target lama tergantikan secara atomic; state
        // pra-import sudah aman di rollbackPoint.
        try {
          atomicWriteFile(target, bytes);
        } catch (e) {
          warnings.push(`skip ${dbFile}: swap gagal (${String(e?.message ?? e)})`);
          skipped.push({ file: dbFile, reason: `swap failed: ${String(e?.message ?? e)}` });
          continue;
        }
        restored.push(dbFile);
      }
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    if (restored.length === 0 && skipped.length === 0) {
      warnings.push('tidak ada DB yang di-restore dari payload');
    }

    return {
      restored,
      skipped,
      warnings,
      rollbackPoint,
      summary: entry.summary,
      manifest: {
        scope: manifest.scope,
        projectIds: Array.isArray(manifest.projectIds) ? manifest.projectIds : [],
        createdAt: manifest.createdAt ?? null,
      },
    };
  }

  /**
   * Import scope 'project'. Keterbatasan fase ini (terdokumentasi): SQLite
   * VACUUM INTO tidak bisa partial → import DB snapshot tetap penuh;
   * importProject = inspect + validasi lalu delegate ke importAll dengan
   * warning 'full-db import'. Partial merge = fase F-lanjut.
   */
  importProject({ projectId, inputPath, password, confirmToken, expectedToken, actor } = {}) {
    if (!projectId || typeof projectId !== 'string') {
      throw validationError('importProject: projectId wajib', { field: 'projectId' });
    }
    const summary = this.inspectImport({ inputPath, password });
    if (summary.scope !== 'project') {
      throw validationError('container bukan scope project', {
        inputPath,
        scope: summary.scope,
      });
    }
    if (!summary.projectIds.includes(projectId)) {
      throw new VmPanelError(NOT_FOUND, `project '${projectId}' tidak ada di export`, {
        projectId,
        exportProjectIds: summary.projectIds,
      });
    }
    // pending entry dari confirmImport (jika confirm dijalankan sebelum call ini)
    // tetap dipakai importAll di bawah via confirmToken.
    const needFreshConfirm = !this._pending.has(confirmToken ?? '');
    let confirm = { confirmToken, expectedToken };
    if (needFreshConfirm) {
      confirm = this.confirmImport({ inputPath, password });
    }
    const result = this.importAll({
      inputPath,
      password,
      confirmToken: confirm.confirmToken,
      expectedToken: confirm.expectedToken ?? CONFIRM_PHRASE,
      actor,
    });
    return {
      ...result,
      warnings: [
        'full-db import: DB snapshot penuh di-restore (partial merge belum didukung fase ini — lihat F-lanjut)',
        ...result.warnings,
      ],
      projectId,
    };
  }
}

export default ImportManager;
