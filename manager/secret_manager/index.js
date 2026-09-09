// manager/secret_manager/index.js — pengelola brankas, koper konfigurasi,
// pemetaan env rahasia, dan startup hooks per-project.
// Menggunakan Vault (lib/vault.js) & crypto bawaan Node.js (AES-256-GCM).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Vault } from '../../lib/vault.js';
import { aesEncrypt, aesDecrypt, randomToken } from '../../lib/crypto.js';
import { VmPanelError, NOT_FOUND, VALIDATION, PERMISSION_DENIED } from '../../lib/errors.js';
import { atomicWriteFile, ensureDir } from '../../lib/fsutil.js';

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 menit

export class SecretManager {
  /**
   * @param {{rootDir: string, dataDir?: string, masterKey?: string, projectsDb?: object}} opts
   */
  constructor({ rootDir, dataDir, masterKey, projectsDb } = {}) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'SecretManager: rootDir wajib');
    }
    this.rootDir = path.resolve(rootDir);
    this.dataDir = dataDir ? path.resolve(dataDir) : path.join(this.rootDir, 'data');
    this.masterKey = masterKey || process.env.VPANEL_MASTER_KEY || null;
    this.projectsDb = projectsDb || null;

    this.secretsDir = path.join(this.rootDir, 'secrets');
    this.vaultPath = path.join(this.secretsDir, 'vault.enc');
    this.refsPath = path.join(this.secretsDir, 'secrets.yaml');
    this.configsDir = path.join(this.secretsDir, 'configs');

    ensureDir(this.secretsDir);
    ensureDir(this.configsDir);

    /** @type {Map<string, {type: string, target: string, expiresAt: number}>} */
    this._confirmTokens = new Map();
  }

  setProjectsDb(db) {
    this.projectsDb = db;
  }

  // --- Inisialisasi Brankas --------------------------------------------------

  isInitialized() {
    return fs.existsSync(this.vaultPath);
  }

  /**
   * Inisialisasi brankas pertama kali jika belum ada.
   * @param {{masterKey?: string}} [opts]
   */
  init({ masterKey } = {}) {
    const key = masterKey || this.masterKey || process.env.VPANEL_MASTER_KEY || randomToken(32);
    this.masterKey = key;
    ensureDir(this.secretsDir);

    if (!fs.existsSync(this.vaultPath)) {
      // Inisialisasi vault kosong dan simpan ke disk
      const vault = new Vault({ filePath: this.vaultPath, masterKey: key });
      vault._save();
    }

    if (!fs.existsSync(this.refsPath)) {
      atomicWriteFile(
        this.refsPath,
        '# VM-Panel secret refs (metadata only, no values)\n# Format: secret_name: { project_scope: "" }\nsecrets: {}\n',
      );
    }

    const secrets = this.listSecrets();
    return {
      initialized: true,
      keyGenerated: !masterKey && !process.env.VPANEL_MASTER_KEY,
      vaultFile: 'secrets/vault.enc',
      refsFile: 'secrets/secrets.yaml',
      secretCount: secrets.length,
    };
  }

  _requireVault() {
    if (!this.isInitialized()) {
      throw new VmPanelError(NOT_FOUND, 'brankas belum diinisialisasi');
    }
    const key = this.masterKey || process.env.VPANEL_MASTER_KEY;
    if (!key) {
      throw new VmPanelError(VALIDATION, 'VPANEL_MASTER_KEY tidak disetel di environment');
    }
    return new Vault({ filePath: this.vaultPath, masterKey: key });
  }

  // --- Operasi Rahasia (Secrets) ---------------------------------------------

  /**
   * Daftar metadata rahasia (TIDAK PERNAH menampilkan nilai).
   */
  listSecrets({ projectScope } = {}) {
    const vault = this._requireVault();
    return vault.list({ projectScope });
  }

  setSecret({ name, value, projectScope, expiresAt }) {
    const vault = this._requireVault();
    vault.set({ name, value, projectScope, expiresAt });
    this._updateRefs();
    return { name, projectScope: projectScope || '', updatedAt: new Date().toISOString() };
  }

  getSecretValue(name, { projectScope } = {}) {
    const vault = this._requireVault();
    return vault.get(name, { projectScope });
  }

  removeSecret(name, { projectScope } = {}) {
    const vault = this._requireVault();
    vault.remove(name, { projectScope });
    this._updateRefs();
    return { removed: true };
  }

  _updateRefs() {
    try {
      const list = this.listSecrets();
      let yaml = '# VM-Panel secret refs (metadata only, no values)\nsecrets:\n';
      for (const s of list) {
        yaml += `  ${s.name}:\n    project_scope: "${s.projectScope || ''}"\n    created_at: "${s.createdAt || ''}"\n`;
      }
      atomicWriteFile(this.refsPath, yaml);
    } catch {
      // Best-effort untuk refs file
    }
  }

  // --- Token Konfirmasi Dua Tahap (Two-Phase Confirm) ------------------------

  issueConfirmToken(type, target) {
    this._cleanExpiredTokens();
    const token = `cfgtok-${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this._confirmTokens.set(token, { type, target, expiresAt });
    return { confirmToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  consumeConfirmToken(token, expectedType, expectedTarget) {
    this._cleanExpiredTokens();
    const item = this._confirmTokens.get(token);
    if (!item) {
      throw new VmPanelError(VALIDATION, 'Token konfirmasi tidak dikenal atau sudah kedaluwarsa');
    }
    this._confirmTokens.delete(token);
    if (item.type !== expectedType || item.target !== expectedTarget) {
      throw new VmPanelError(PERMISSION_DENIED, 'Token konfirmasi tidak cocok untuk target ini');
    }
    return true;
  }

  _cleanExpiredTokens() {
    const now = Date.now();
    for (const [k, v] of this._confirmTokens.entries()) {
      if (now > v.expiresAt) this._confirmTokens.delete(k);
    }
  }

  // --- File Koper Konfigurasi (Project Configs) -------------------------------

  _projectConfigDir(projectId) {
    const p = path.join(this.configsDir, projectId);
    ensureDir(p);
    return p;
  }

  listConfigs(projectId) {
    const p = this._projectConfigDir(projectId);
    const files = fs.readdirSync(p).filter((f) => f.endsWith('.json'));
    const rows = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(p, f), 'utf8');
        const data = JSON.parse(raw);
        rows.push({
          filename: data.filename,
          sizeBytes: data.sizeBytes,
          sha256: data.sha256,
          updatedAt: data.updatedAt,
        });
      } catch {
        // Abaikan file rusak
      }
    }
    rows.sort((a, b) => a.filename.localeCompare(b.filename));
    return rows;
  }

  _getKey32() {
    const key = this.masterKey || process.env.VPANEL_MASTER_KEY || 'default-secret-key-min-32-chars-long';
    return crypto.createHash('sha256').update(String(key)).digest();
  }

  getConfig(projectId, filename) {
    const p = path.join(this._projectConfigDir(projectId), `${filename}.json`);
    if (!fs.existsSync(p)) {
      throw new VmPanelError(NOT_FOUND, `Config "${filename}" tidak ditemukan`);
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const key32 = this._getKey32();
    const contentBase64 = aesDecrypt(key32, data.encrypted);
    return {
      projectId,
      filename: data.filename,
      sizeBytes: data.sizeBytes,
      sha256: data.sha256,
      updatedAt: data.updatedAt,
      contentBase64,
    };
  }

  saveConfig(projectId, { filename, contentBase64 }) {
    if (!filename || typeof filename !== 'string' || /[\\/\0]/.test(filename)) {
      throw new VmPanelError(VALIDATION, 'Nama file config tidak valid');
    }
    if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
      throw new VmPanelError(VALIDATION, 'Isi file config kosong');
    }
    const buf = Buffer.from(contentBase64, 'base64');
    const sizeBytes = buf.length;
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const updatedAt = new Date().toISOString();

    const key32 = this._getKey32();
    const encrypted = aesEncrypt(key32, contentBase64);

    const record = {
      filename,
      sizeBytes,
      sha256,
      updatedAt,
      encrypted,
    };

    const dest = path.join(this._projectConfigDir(projectId), `${filename}.json`);
    atomicWriteFile(dest, JSON.stringify(record, null, 2));
    return { projectId, filename, sizeBytes, sha256, updatedAt };
  }

  removeConfig(projectId, filename) {
    const dest = path.join(this._projectConfigDir(projectId), `${filename}.json`);
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
    }
    return { removed: true };
  }

  // --- Project Env Refs (Pemetaan Variabel Rahasia) --------------------------

  _getDb() {
    if (!this.projectsDb) {
      throw new VmPanelError(VALIDATION, 'Database projects belum tersambung ke SecretManager');
    }
    return this.projectsDb;
  }

  listProjectEnv(projectId) {
    const db = this._getDb();
    const rows = db.prepare(
      'SELECT env_name, secret_ref FROM project_env_refs WHERE project_id = ? ORDER BY env_name ASC',
    ).all(projectId);
    return rows.map((r) => ({ envName: r.env_name, secretName: r.secret_ref }));
  }

  setProjectEnv(projectId, { envName, secretName }) {
    if (!envName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new VmPanelError(VALIDATION, 'Nama variabel env tidak valid');
    }
    if (!secretName || typeof secretName !== 'string') {
      throw new VmPanelError(VALIDATION, 'Nama secret wajib diisi');
    }
    const db = this._getDb();
    db.prepare(
      'INSERT INTO project_env_refs (project_id, env_name, secret_ref) VALUES (?, ?, ?) ON CONFLICT(project_id, env_name) DO UPDATE SET secret_ref = excluded.secret_ref',
    ).run(projectId, envName, secretName);
    return { projectId, envName, secretName };
  }

  removeProjectEnv(projectId, envName) {
    const db = this._getDb();
    db.prepare('DELETE FROM project_env_refs WHERE project_id = ? AND env_name = ?').run(projectId, envName);
    return { removed: true };
  }

  // --- Project Hooks (Suntikan Otomatis Startup) -----------------------------

  getProjectHook(projectId) {
    const db = this._getDb();
    const row = db.prepare(
      'SELECT config_json, updated_at FROM project_hooks WHERE project_id = ?',
    ).get(projectId);
    if (!row) return null;
    try {
      const cfg = JSON.parse(row.config_json);
      return { ...cfg, updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  setProjectHook(projectId, { url, bodyFile, secretFields }) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new VmPanelError(VALIDATION, 'URL hook tidak valid (harus http:// atau https://)');
    }
    const cfg = {
      url,
      bodyFile: bodyFile || '',
      secretFields: Array.isArray(secretFields) ? secretFields : [],
    };
    const now = new Date().toISOString();
    const db = this._getDb();
    db.prepare(
      "INSERT INTO project_hooks (project_id, hook_type, config_json, updated_at) VALUES (?, 'startup', ?, ?) ON CONFLICT(project_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at",
    ).run(projectId, JSON.stringify(cfg), now);
    return { projectId, hook: { ...cfg, updatedAt: now } };
  }

  removeProjectHook(projectId) {
    const db = this._getDb();
    db.prepare('DELETE FROM project_hooks WHERE project_id = ?').run(projectId);
    return { removed: true };
  }

  async testProjectHook(projectId) {
    const hook = this.getProjectHook(projectId);
    if (!hook || !hook.url) {
      throw new VmPanelError(VALIDATION, 'Hook belum dikonfigurasi untuk project ini');
    }
    try {
      const res = await fetch(hook.url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return { ok: res.ok, status: res.status, attempts: 1 };
    } catch (e) {
      return { ok: false, status: null, attempts: 1, error: String(e?.message ?? e) };
    }
  }
}
