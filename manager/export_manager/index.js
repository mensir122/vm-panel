// manager/export_manager/index.js — ExportManager (docs/DESIGN.md §10, keputusan D9c + D10a).
//
// Format file export: `*.vpe` (VM-Panel Export) = JSON container di-gzip (zero-dep,
// zlib bawaan — BUKAN tar; konten bukan tar sehingga ekstensi tetap .vpe):
//
//   plaintext : gzip(JSON.stringify({ magic:'VPEXPORT1', manifest, payload }))
//   encrypted : gzip(JSON.stringify({ magic:'VPEXPORT1E', envelope }))   — envelope
//               = AES-256-GCM (lib/crypto.js aesEncrypt) atas JSON container
//               plaintext; kunci = PBKDF2-SHA256(password, salt 'export',
//               purpose label 'export', 600000 iterasi) via deriveKey().
//
// manifest : { version, scope ('project'|'all'), createdAt, appVersion, projectIds,
//              encrypted:false|'aes-256-gcm', pbkdf2?:{salt, iterations},
//              files:[{path,size,sha256}], containsDbSnapshots:true, dbSnapshotNote }
// payload  : { '<relpath POSIX>': { b64: '<base64 konten>' } }
//
// relpath SELALU POSIX-style forward-slash, relative root export:
//   db/platform.db … db/backups.db, registry/export-registry.json
//
// SECRET NEVER (AGENTS.md §2/§3): export HANYA berisi snapshot DB + registry.
// users.db / audit.db (panel-owned) TIDAK diikutkan default (audit opsional via
// includeAudit). secrets/vault.enc TIDAK pernah diikutkan. Kolom secret di
// registry dibuang. DB snapshot tetap berisi data operasional (termasuk kolom
// secret_ref yang hanyalah pointer) — dicatat eksplisit di manifest
// (containsDbSnapshots:true) agar penerima tahu file ini sensitif.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import { openDatabase } from '../../lib/db.js';
import { aesEncrypt, deriveKey, randomToken } from '../../lib/crypto.js';
import { VmPanelError, VALIDATION, NOT_FOUND } from '../../lib/errors.js';
import { atomicWriteFile } from '../../lib/fsutil.js';

const MAGIC_PLAIN = 'VPEXPORT1';
const MAGIC_ENCRYPTED = 'VPEXPORT1E';
const EXPORT_VERSION = 1;
const PBKDF2_SALT = 'export';
const PBKDF2_PURPOSE = 'export';
const PBKDF2_ITERATIONS = 600000; // D10a

/** 6 DB inti manager (panel-owned users.db/audit.db dikecualikan default). */
const CORE_DBS = Object.freeze([
  { file: 'platform.db', schema: 'platform' },
  { file: 'projects.db', schema: 'projects' },
  { file: 'services.db', schema: 'services' },
  { file: 'deployments.db', schema: 'deployments' },
  { file: 'health.db', schema: 'health' },
  { file: 'backups.db', schema: 'backups' },
]);

const AUDIT_DB = Object.freeze({ file: 'audit.db', schema: 'audit' });

/** Pola nama kolom yang dibuang dari registry export (nilai, bukan ref). */
const SECRET_COL_RE = /secret|password|passwd|token|api[_-]?key|private[_-]?key|session/i;

function nowIso() {
  return new Date().toISOString();
}

function validationError(message, details) {
  return new VmPanelError(VALIDATION, message, details);
}

function readAppVersion() {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(url, 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Buang kolom secret dari satu row registry (ref tetap boleh; nilai tidak ada di row). */
function stripSecretColumns(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_COL_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * ExportManager — pembuat file export .vpe (plaintext / AES-256-GCM).
 * Snapshot DB via pola backup: openDatabase(nama) → vacuumInto(staging) → close.
 */
export class ExportManager {
  /**
   * @param {{dataDir: string, projectsDbPath?: string}} opts
   *        dataDir  = folder berisi *.db manager (platform.db, projects.db, …)
   *        projectsDbPath = override lokasi projects.db (opsional).
   */
  constructor({ dataDir, projectsDbPath } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw validationError('ExportManager: dataDir wajib', { field: 'dataDir' });
    }
    this.dataDir = path.resolve(dataDir);
    this.projectsDbPath = projectsDbPath
      ? path.resolve(projectsDbPath)
      : path.join(this.dataDir, 'projects.db');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.appVersion = readAppVersion();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Snapshot satu DB ke staging via VACUUM INTO, baca bytes-nya.
   * DB yang tidak ada → null (payload skip; import-side whitelist menangani).
   * @returns {Buffer|null}
   */
  _snapshotDbBytes(dbFile, schemaName, stagingDir) {
    const src = path.join(this.dataDir, dbFile);
    if (!fs.existsSync(src)) return null;
    const handle = openDatabase(src, { schemaName });
    const stagingFile = path.join(stagingDir, dbFile);
    try {
      handle.vacuumInto(stagingFile);
      return fs.readFileSync(stagingFile);
    } finally {
      handle.close();
    }
  }

  /** Buka projects.db live; cek project ada (untuk exportProject). */
  _projectExists(projectId) {
    if (!fs.existsSync(this.projectsDbPath)) return false;
    const handle = openDatabase(this.projectsDbPath, { schemaName: 'projects' });
    try {
      return !!handle.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    } finally {
      handle.close();
    }
  }

  /**
   * Dump satu tabel registry (SELECT *), filter opsional, buang kolom secret.
   * DB tidak ada → [] (sistem fresh sebagian terpasang tetap valid).
   */
  _dumpTable(dbFile, schemaName, table, filter) {
    const p = path.join(this.dataDir, dbFile);
    if (!fs.existsSync(p)) return [];
    const handle = openDatabase(p, { schemaName });
    try {
      const rows = filter
        ? handle.db.prepare(`SELECT * FROM ${table} WHERE ${filter.col} = ?`).all(filter.val)
        : handle.db.prepare(`SELECT * FROM ${table}`).all();
      return rows.map(stripSecretColumns);
    } finally {
      handle.close();
    }
  }

  /**
   * export-registry.json: dump rows projects + services (TANPA kolom secret —
   * kolom config/env_ref/secret pointer boleh; nilai secret TIDAK ada di DB registry).
   */
  _buildRegistry({ scope, projectId }) {
    const projects = this._dumpTable('projects.db', 'projects', 'projects', projectId ? { col: 'id', val: projectId } : null);
    const services = this._dumpTable('services.db', 'services', 'services', projectId ? { col: 'project_id', val: projectId } : null);
    return {
      exportedAt: nowIso(),
      scope,
      projectId: projectId ?? null,
      counts: { projects: projects.length, services: services.length },
      projects,
      services,
    };
  }

  /**
   * Pipeline inti: staging snapshot → payload b64 → manifest → container →
   * (opsional enkripsi) → gzip → atomic write. Return ringkasan manifest.
   */
  _runExport({ outputPath, scope, projectIds, encrypted, password, includeAudit }) {
    const stagingDir = path.join(this.dataDir, `.export-staging-${randomToken(8)}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
      const payload = {};
      const files = [];
      const totalHash = createHash('sha256');
      let totalBytes = 0;

      const addPayload = (relpath, bytes) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        payload[relpath] = { b64: bytes.toString('base64') };
        files.push({ path: relpath, size: bytes.length, sha256 });
        totalHash.update(bytes);
        totalBytes += bytes.length;
      };

      const dbList = includeAudit ? [...CORE_DBS, AUDIT_DB] : [...CORE_DBS];
      for (const { file, schema } of dbList) {
        const bytes = this._snapshotDbBytes(file, schema, stagingDir);
        if (bytes) addPayload(`db/${file}`, bytes);
      }

      const registry = this._buildRegistry({ scope, projectId: scope === 'project' ? projectIds[0] : null });
      addPayload('registry/export-registry.json', Buffer.from(JSON.stringify(registry, null, 2), 'utf8'));

      /** Keterbatasan terdokumentasi: SQLite VACUUM INTO tidak bisa partial —
       *  scope 'project' tetap snapshot DB penuh; filter hanya di registry. */
      const dbSnapshotNote =
        'DB snapshots are FULL (VACUUM INTO cannot be partial); project scoping applies to the registry only. Snapshots contain operational data (NOT the vault — secrets/vault.enc is never included).';

      const manifest = {
        version: EXPORT_VERSION,
        scope,
        createdAt: nowIso(),
        appVersion: this.appVersion,
        projectIds,
        encrypted: encrypted ? 'aes-256-gcm' : false,
        ...(encrypted ? { pbkdf2: { salt: PBKDF2_SALT, iterations: PBKDF2_ITERATIONS } } : {}),
        files,
        containsDbSnapshots: true,
        dbSnapshotNote,
      };

      const container = { magic: MAGIC_PLAIN, manifest, payload };

      let outBytes;
      if (encrypted) {
        // D10a: kunci = PBKDF2-SHA256(password, salt 'export', purpose 'export', 600k)
        const key = deriveKey(password, PBKDF2_SALT, PBKDF2_PURPOSE);
        const envelope = aesEncrypt(key, JSON.stringify(container));
        outBytes = zlib.gzipSync(Buffer.from(JSON.stringify({ magic: MAGIC_ENCRYPTED, envelope }), 'utf8'));
      } else {
        outBytes = zlib.gzipSync(Buffer.from(JSON.stringify(container), 'utf8'));
      }

      atomicWriteFile(outputPath, outBytes);

      return {
        outputPath,
        magic: encrypted ? MAGIC_ENCRYPTED : MAGIC_PLAIN,
        sizeBytes: outBytes.length,
        manifest: {
          version: EXPORT_VERSION,
          scope,
          createdAt: manifest.createdAt,
          appVersion: this.appVersion,
          projectIds,
          encrypted: manifest.encrypted,
          fileCount: files.length,
          totalBytes,
          payloadSha256: totalHash.digest('hex'),
          containsDbSnapshots: true,
        },
      };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Export scope 'all'.
   * @param {{
   *   outputPath: string, encrypted?: boolean, password?: string,
   *   includeAudit?: boolean,
   * }} opts
   * @returns {{outputPath, magic, sizeBytes, manifest: object}}
   */
  exportAll({ outputPath, encrypted = false, password, includeAudit = false } = {}) {
    if (!outputPath || typeof outputPath !== 'string') {
      throw validationError('exportAll: outputPath wajib', { field: 'outputPath' });
    }
    if (encrypted && (!password || typeof password !== 'string')) {
      throw validationError('exportAll: encrypted=true membutuhkan password', {
        field: 'password',
      });
    }
    // scope 'all': projectIds = semua id project yang ada di projects.db (metadata).
    let projectIds = [];
    if (fs.existsSync(this.projectsDbPath)) {
      const handle = openDatabase(this.projectsDbPath, { schemaName: 'projects' });
      try {
        projectIds = handle.db.prepare('SELECT id FROM projects ORDER BY id').all().map((r) => r.id);
      } finally {
        handle.close();
      }
    }
    return this._runExport({
      outputPath,
      scope: 'all',
      projectIds,
      encrypted: !!encrypted,
      password,
      includeAudit: !!includeAudit,
    });
  }

  /**
   * Export scope 'project' (satu project). DB snapshot tetap penuh (SQLite
   * tidak bisa partial aman); registry difilter ke project tsb.
   * Project tidak ada → NOT_FOUND.
   */
  exportProject({ projectId, outputPath, encrypted = false, password, includeAudit = false } = {}) {
    if (!projectId || typeof projectId !== 'string') {
      throw validationError('exportProject: projectId wajib', { field: 'projectId' });
    }
    if (!outputPath || typeof outputPath !== 'string') {
      throw validationError('exportProject: outputPath wajib', { field: 'outputPath' });
    }
    if (encrypted && (!password || typeof password !== 'string')) {
      throw validationError('exportProject: encrypted=true membutuhkan password', {
        field: 'password',
      });
    }
    if (!this._projectExists(projectId)) {
      throw new VmPanelError(NOT_FOUND, `project tidak ditemukan: ${projectId}`, { projectId });
    }
    return this._runExport({
      outputPath,
      scope: 'project',
      projectIds: [projectId],
      encrypted: !!encrypted,
      password,
      includeAudit: !!includeAudit,
    });
  }
}

export default ExportManager;
