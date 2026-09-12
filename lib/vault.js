// lib/vault.js — encrypted-at-rest secret store (DESIGN §13)
// File = satu envelope JSON terenkripsi AES-256-GCM. kEnc di-derive dari
// masterKey + salt file (PBKDF2-SHA256 600k, label 'enc'). Atomic write:
// tmp + rename (mandiri, tanpa import lib lain).
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { aesEncrypt, aesDecrypt, deriveKeys } from './crypto.js';

const FILE_TMP_SWEEP_OLDER_THAN_MS = 3_600_000; // 1 jam

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function vaultError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function nowIso() {
  return new Date().toISOString();
}

const FILE_FORMAT_VERSION = 1;

/**
 * class Vault({filePath, masterKey})
 * - masterKey: string (env VPANEL_MASTER_KEY atau argumen).
 * - File on-disk: JSON {version, salt, envelope:{iv,tag,ct}} — envelope
 *   mengenkripsi payload {secrets:{name:{value, projectScope, createdAt,
 *   rotatedAt, expiresAt}}}.
 * - Kunci: deriveKeys(masterKey, salt).kEnc (label 'enc' di salt).
 * - Tamper (GCM tag gagal) → throw saat load.
 */
export class Vault {
  constructor({ filePath, masterKey } = {}) {
    if (!filePath || typeof filePath !== 'string') {
      throw vaultError('VAULT_CONFIG', 'Vault requires filePath');
    }
    if (typeof masterKey !== 'string' || masterKey.length === 0) {
      throw vaultError('VAULT_CONFIG', 'Vault requires non-empty masterKey');
    }
    this.filePath = filePath;
    this.masterKey = masterKey;
    this._data = { secrets: {} };
    this._load();
  }

  // ---- persistence -------------------------------------------------------

  _encryptPayload(payloadObj) {
    // salt file stabil (disimpan di file); jika file belum ada → salt baru
    let saltB64;
    if (existsSync(this.filePath)) {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      saltB64 = raw.salt;
    } else {
      saltB64 = randomBytes(16).toString('base64');
    }
    const salt = Buffer.from(saltB64, 'base64');
    const { kEnc } = deriveKeys(this.masterKey, salt);
    const envelope = aesEncrypt(kEnc, JSON.stringify(payloadObj));
    return {
      version: FILE_FORMAT_VERSION,
      salt: saltB64,
      envelope,
    };
  }

  _atomicWriteFile(obj) {
    const dir = dirname(this.filePath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    // tulis tmp → flush+rename (pattern tmp+rename mandiri)
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
    try {
      renameSync(tmp, this.filePath);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
  }

  /**
   * Sweep sisa file tmp atomic-write (`<vault>.tmp-<pid>-<ts>`) yang berumur
   * lebih tua dari 1 jam — peninggalan proses yang crash sebelum rename.
   * Best-effort: setiap error per-file diabaikan. Return list path terhapus.
   */
  _sweepStaleTmp({ olderThanMs = FILE_TMP_SWEEP_OLDER_THAN_MS, now = Date.now() } = {}) {
    const removed = [];
    const dir = dirname(this.filePath);
    const re = new RegExp(
      `^${escapeRegExp(basename(this.filePath))}\\.tmp-\\d+(-\\d+)?$`,
    );
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return removed; // direktori vault belum ada
    }
    for (const name of names) {
      if (!re.test(name)) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs < olderThanMs) continue; // masih muda — biar
        unlinkSync(full);
        removed.push(full);
      } catch {
        /* hilang di tengah / terkunci — abaikan */
      }
    }
    return removed;
  }

  _load() {
    // F3: sapu sisa tmp atomic-write dari proses yang crash SEBELUM baca file.
    // Pola ketat `<namaFileVault>.tmp-<digits>[-<digits>]` + umur > 1 jam —
    // tmp milik write yang masih berjalan (proses lain) tidak pernah disentuh.
    this._sweepStaleTmp();
    if (!existsSync(this.filePath)) return; // vault baru
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (e) {
      throw vaultError('VAULT_CORRUPT', `vault file is not valid JSON: ${e.message}`);
    }
    if (!raw || typeof raw !== 'object' || typeof raw.salt !== 'string' || !raw.envelope) {
      throw vaultError('VAULT_CORRUPT', 'vault file structure invalid');
    }
    const salt = Buffer.from(raw.salt, 'base64');
    const { kEnc } = deriveKeys(this.masterKey, salt);
    let payload;
    try {
      payload = aesDecrypt(kEnc, raw.envelope);
    } catch {
      // GCM tag gagal → master key salah ATAU file di-tamper.
      throw vaultError(
        'VAULT_DECRYPT_FAIL',
        'vault decrypt failed: wrong master key or tampered file',
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (e) {
      throw vaultError('VAULT_CORRUPT', `vault payload is not valid JSON: ${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.secrets !== 'object') {
      throw vaultError('VAULT_CORRUPT', 'vault payload structure invalid');
    }
    this._data = parsed;
  }

  _save() {
    const fileObj = this._encryptPayload(this._data);
    this._atomicWriteFile(fileObj);
  }

  // ---- API ---------------------------------------------------------------

  /**
   * Simpan secret. Return metadata (tanpa value).
   */
  set(name, value, { projectScope = null, expiresAt = null } = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw vaultError('VAULT_INVALID_NAME', 'secret name required');
    }
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
      throw vaultError('VAULT_INVALID_VALUE', 'secret value must be string or Buffer');
    }
    const existing = this._data.secrets[name];
    this._data.secrets[name] = {
      value: Buffer.isBuffer(value) ? value.toString('utf8') : value,
      projectScope,
      createdAt: existing?.createdAt ?? nowIso(),
      rotatedAt: existing ? nowIso() : existing?.rotatedAt ?? null,
      expiresAt: expiresAt ?? existing?.expiresAt ?? null,
    };
    this._save();
    return this.list().find((m) => m.name === name);
  }

  /**
   * Ambil value secret. Nama tak ada ATAU scope mismatch → SECRET_NOT_FOUND
   * (pesan generik identik — tidak bocorkan bedanya).
   */
  get(name, { projectScope = null } = {}) {
    const rec = this._data.secrets[name];
    if (!rec || rec.projectScope !== projectScope) {
      throw vaultError('SECRET_NOT_FOUND', `secret not found: ${name}`);
    }
    return rec.value;
  }

  /** Update value + rotatedAt. Nama tak ada → SECRET_NOT_FOUND. */
  rotate(name, newValue) {
    const rec = this._data.secrets[name];
    if (!rec) {
      throw vaultError('SECRET_NOT_FOUND', `secret not found: ${name}`);
    }
    if (typeof newValue !== 'string' && !Buffer.isBuffer(newValue)) {
      throw vaultError('VAULT_INVALID_VALUE', 'secret value must be string or Buffer');
    }
    rec.value = Buffer.isBuffer(newValue) ? newValue.toString('utf8') : newValue;
    rec.rotatedAt = nowIso();
    this._save();
    return this.list().find((m) => m.name === name);
  }

  /** Hapus secret. Nama tak ada → SECRET_NOT_FOUND. */
  remove(name) {
    if (!(name in this._data.secrets)) {
      throw vaultError('SECRET_NOT_FOUND', `secret not found: ${name}`);
    }
    delete this._data.secrets[name];
    this._save();
  }

  /** Metadata TANPA value. */
  list() {
    return Object.entries(this._data.secrets)
      .map(([name, rec]) => ({
        name,
        projectScope: rec.projectScope,
        createdAt: rec.createdAt,
        rotatedAt: rec.rotatedAt,
        expiresAt: rec.expiresAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Fingerprint master key (untuk debug, bukan secret itu sendiri). */
  _keyFingerprint() {
    return createHash('sha256').update(this.masterKey).digest('hex').slice(0, 16);
  }
}

export default Vault;
