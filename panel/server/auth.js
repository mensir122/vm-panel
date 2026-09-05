// panel/server/auth.js — PanelAuth: autentikasi panel web (docs/DESIGN.md §16).
// users.db via openDatabase(schemaName 'users') + PermissionManager internal.
//   - bootstrapOwner sekali: owner + password scrypt + TOTP secret TERENKRIPSI
//     (AES-256-GCM, kEnc dari deriveKeys(master key)) + 10 recovery codes
//     (hash sha256; plaintext dikembalikan SEKALI, never again)
//   - login: lockout 5 gagal / 15 menit; faktor kedua wajib (TOTP window ±1
//     ATAU recovery code sekali pakai); session 8 jam + csrf_token
//   - cookie: vpanel_session HttpOnly SameSite=Strict (+ Secure hanya https)
//   - CSRF double-submit: session.csrfToken + cookie vpanel_csrf + header/body
// MASTER KEY: env VPANEL_MASTER_KEY, atau random sekali disimpan di meta
// users.db 'panel_key' (salt di meta 'panel_key_salt').
// ATURAN REDAKSI: password / kode TOTP / recovery code TIDAK PERNAH masuk
// log maupun audit — hanya metadata (username, ip, result).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { openDatabase } from '../../lib/db.js';
import {
  scryptHash,
  scryptVerify,
  aesEncrypt,
  aesDecrypt,
  randomToken,
  totpVerify,
  deriveKeys,
} from '../../lib/crypto.js';
import { VmPanelError, VALIDATION, NOT_FOUND, PERMISSION_DENIED } from '../../lib/errors.js';
import { PermissionManager } from '../../manager/permission_manager/index.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 jam (= 28800 s)
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 4; // randomToken(4) → 8 char hex
const TOTP_SECRET_BYTES = 20;

export const SESSION_COOKIE = 'vpanel_session';
export const CSRF_COOKIE = 'vpanel_csrf';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode Buffer → base32 RFC 4648 (untuk secret TOTP 20 byte → 32 char). */
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function sha256Hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

/** Bandingkan string konstanta-waktu (hash recovery code / csrf). */
function safeEqualStr(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class PanelAuth {
  /**
   * @param {{dataDir: string, auditManager?: object,
   *          now?: () => number, sessionTtlMs?: number}} opts
   * `now` injectable untuk test (default Date.now); sessionTtlMs override TTL.
   */
  constructor({ dataDir, auditManager, now, sessionTtlMs } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'PanelAuth: dataDir wajib');
    }
    this.#h = openDatabase(join(dataDir, 'users.db'), { schemaName: 'users' });
    this.#h.migrate();
    this.#perm = new PermissionManager({ dataDir });
    this.#auditManager = auditManager ?? null;
    this.#now = typeof now === 'function' ? now : () => Date.now();
    const ttl = Number(sessionTtlMs);
    this.#sessionTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_TTL_MS;
    this.#stmts = {
      getUserByUsernameFull: this.#h.db.prepare('SELECT * FROM users WHERE username = ?'),
      getUserByIdFull: this.#h.db.prepare('SELECT * FROM users WHERE id = ?'),
      setPassword: this.#h.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?'),
      setActive: this.#h.db.prepare("UPDATE users SET status = 'active' WHERE id = ?"),
      setTotpSecret: this.#h.db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?'),
      setFail: this.#h.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?'),
      loginOk: this.#h.db.prepare(
        'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?',
      ),
      insSession: this.#h.db.prepare(
        'INSERT INTO sessions (id, user_id, created_at, expires_at, csrf_token, revoked) VALUES (?, ?, ?, ?, ?, 0)',
      ),
      getSession: this.#h.db.prepare('SELECT * FROM sessions WHERE id = ?'),
      delSession: this.#h.db.prepare('DELETE FROM sessions WHERE id = ?'),
      delExpiredSessions: this.#h.db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      recoveryUnused: this.#h.db.prepare(
        'SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
      ),
      recoveryMarkUsed: this.#h.db.prepare(
        'UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
      ),
      recoveryDelForUser: this.#h.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?'),
      recoveryIns: this.#h.db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)'),
      listUsers: this.#h.db.prepare(
        'SELECT id, username, role, status, created_at, last_login_at FROM users ORDER BY created_at, username',
      ),
    };
  }

  #h;
  #perm;
  #auditManager;
  #now;
  #sessionTtlMs;
  #stmts;
  #kEnc = null;

  // --- helpers -------------------------------------------------------------

  #iso(ms) {
    return new Date(ms).toISOString();
  }

  /** Audit append non-fatal (kegagalan audit tidak boleh memblok auth). */
  #audit(operation, fields = {}) {
    if (!this.#auditManager) return;
    try {
      this.#auditManager.append({ operation, ...fields });
    } catch {
      // audit tidak boleh memutus alur auth; kegagalan diamkan (tanpa secret)
    }
  }

  /** kEnc dari deriveKeys(masterKey, salt); master key env atau random di meta. */
  #getKEnc() {
    if (this.#kEnc) return this.#kEnc;
    let master = process.env.VPANEL_MASTER_KEY
      ? String(process.env.VPANEL_MASTER_KEY).trim()
      : '';
    if (!master) {
      master = this.#h.getMeta('panel_key');
      if (!master) {
        master = randomToken(32);
        this.#h.setMeta('panel_key', master);
      }
    }
    let salt = this.#h.getMeta('panel_key_salt');
    if (!salt) {
      salt = randomBytes(16).toString('hex');
      this.#h.setMeta('panel_key_salt', salt);
    }
    this.#kEnc = deriveKeys(master, salt).kEnc;
    return this.#kEnc;
  }

  #encryptTotpSecret(secretBase32) {
    const envelope = aesEncrypt(this.#getKEnc(), secretBase32);
    return JSON.stringify({ v: 1, ...envelope });
  }

  #decryptTotpSecret(stored) {
    if (!stored || typeof stored !== 'string' || stored === '') return null;
    let envelope;
    try {
      envelope = JSON.parse(stored);
    } catch {
      throw new VmPanelError(VALIDATION, 'totp_secret tersimpan bukan envelope valid');
    }
    return aesDecrypt(this.#getKEnc(), envelope);
  }

  #setOwnerPassword(username, password) {
    const { salt, hash, params } = scryptHash(password);
    const info = this.#stmts.setPassword.run(JSON.stringify({ salt, hash, params }), username);
    if (info.changes === 0) {
      throw new VmPanelError(NOT_FOUND, `user tidak ditemukan: ${username}`);
    }
  }

  #consumeRecoveryCode(userId, code) {
    const hash = sha256Hex(String(code).trim().toLowerCase());
    const rows = this.#stmts.recoveryUnused.all(String(userId));
    for (const r of rows) {
      if (safeEqualStr(r.code_hash, hash)) {
        const info = this.#stmts.recoveryMarkUsed.run(this.#iso(this.#now()), r.id);
        return info.changes > 0;
      }
    }
    return false;
  }

  #userFromRow(row) {
    return {
      userId: row.id,
      username: row.username,
      role: row.role,
      status: row.status,
    };
  }

  // --- API utama -------------------------------------------------------------

  /**
   * Bootstrap owner pertama (SEKALI): ensureOwnerBootstrap → set password →
   * status active → TOTP secret (encrypted-at-rest) → 10 recovery codes.
   * Return {username, totpSecretBase32, recoveryCodes} — plaintext SEKALI saja;
   * dipanggil lagi (totp_secret sudah ada) → VALIDATION.
   */
  bootstrapOwner({ username = 'admin', password } = {}) {
    const u = typeof username === 'string' ? username.trim() : '';
    if (u === '' || typeof password !== 'string' || password.length < 8) {
      throw new VmPanelError(VALIDATION, 'bootstrapOwner: username dan password (min 8 char) wajib');
    }
    this.#perm.ensureOwnerBootstrap({ username: u });
    const user = this.#perm.getUserByUsername(u);
    if (!user) {
      throw new VmPanelError(NOT_FOUND, `bootstrapOwner: user tidak ditemukan setelah bootstrap: ${u}`);
    }
    const row = this.#stmts.getUserByIdFull.get(user.userId);
    if (row && row.totp_secret) {
      throw new VmPanelError(
        VALIDATION,
        'bootstrapOwner: sudah pernah dilakukan (secret/recovery hanya dikembalikan sekali)',
      );
    }
    this.#setOwnerPassword(u, password);
    this.#stmts.setActive.run(user.userId); // bootstrap selesai → active
    const secretBase32 = base32Encode(randomBytes(TOTP_SECRET_BYTES));
    this.#stmts.setTotpSecret.run(this.#encryptTotpSecret(secretBase32), user.userId);
    const recoveryCodes = this.issueRecoveryCodes(u);
    this.#audit('PANEL_BOOTSTRAP', {
      actor: u,
      userId: user.userId,
      role: 'owner',
      result: 'ok',
    });
    return { username: u, totpSecretBase32: secretBase32, recoveryCodes };
  }

  /**
   * Regenerate recovery codes user (hash disimpan; plaintext dikembalikan
   * sekali). Kode lama yang belum terpakai dihapus.
   */
  issueRecoveryCodes(username) {
    const user = this.#perm.getUserByUsername(username);
    if (!user) {
      throw new VmPanelError(NOT_FOUND, `user tidak ditemukan: ${username}`);
    }
    const codes = [];
    this.#h.tx(() => {
      this.#stmts.recoveryDelForUser.run(user.userId);
      for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        const code = randomToken(RECOVERY_CODE_BYTES); // 8 char hex
        codes.push(code);
        this.#stmts.recoveryIns.run(user.userId, sha256Hex(code));
      }
    });
    return codes;
  }

  /** Set/ubah password user (scrypt → JSON {salt,hash,params} di password_hash). */
  setPassword(username, password) {
    if (typeof username !== 'string' || username.trim() === '' || typeof password !== 'string' || password === '') {
      throw new VmPanelError(VALIDATION, 'setPassword: username dan password wajib');
    }
    this.#setOwnerPassword(username.trim(), password);
  }

  /**
   * Login (§16): lockout check → password (scrypt) → faktor kedua (TOTP /
   * recovery) → session baru. Password/kode TIDAK PERNAH di-log/audit.
   * @returns {{ok:true, sessionId, sessionCookie, csrfCookie, csrfToken, user}
   *          |{ok:false, reason:'invalid'|'invalid_2fa'|'locked'}}
   */
  login({ username, password, totpCode, recoveryCode, ip, secure = false } = {}) {
    const u = typeof username === 'string' ? username.trim() : '';
    const nowMs = this.#now();
    const nowIso = this.#iso(nowMs);

    const finish = (reason) => ({ ok: false, reason });
    if (u === '' || typeof password !== 'string' || password === '') return finish('invalid');

    const row = this.#stmts.getUserByUsernameFull.get(u);
    if (!row || !row.password_hash) {
      this.#audit('LOGIN_FAIL', { actor: u, ip, result: 'fail' });
      return finish('invalid');
    }

    // lockout: failed_attempts >= 5 && locked_until > now
    const lockedUntil = row.locked_until ? Date.parse(row.locked_until) : 0;
    if (Number(row.failed_attempts ?? 0) >= MAX_FAILED_ATTEMPTS && lockedUntil > nowMs) {
      return finish('locked');
    }

    let stored;
    try {
      stored = JSON.parse(row.password_hash);
    } catch {
      stored = null;
    }
    if (!stored || !scryptVerify(password, stored)) {
      const attempts = Number(row.failed_attempts ?? 0) + 1;
      const newLock = attempts >= MAX_FAILED_ATTEMPTS ? this.#iso(nowMs + LOCK_WINDOW_MS) : row.locked_until;
      this.#stmts.setFail.run(attempts, newLock, row.id);
      this.#audit('LOGIN_FAIL', { actor: u, userId: row.id, ip, result: 'fail' });
      return finish('invalid');
    }

    // Faktor kedua wajib: TOTP (window ±1) ATAU recovery code sekali pakai
    let secondFactor = false;
    let secretBase32 = null;
    try {
      secretBase32 = this.#decryptTotpSecret(row.totp_secret);
    } catch {
      // Kunci enkripsi tidak cocok (mis. master key berubah) — perlakukan
      // sebagai 2FA gagal, JANGAN biarkan melempar 500 INTERNAL.
      secretBase32 = null;
    }
    if (secretBase32 && typeof totpCode === 'string' && totpCode.trim() !== '') {
      secondFactor = totpVerify(secretBase32, totpCode.trim(), { window: 1 });
    }
    if (!secondFactor && typeof recoveryCode === 'string' && recoveryCode.trim() !== '') {
      secondFactor = this.#consumeRecoveryCode(row.id, recoveryCode);
    }
    if (!secondFactor) {
      this.#audit('LOGIN_FAIL_2FA', { actor: u, userId: row.id, ip, result: 'fail' });
      return finish('invalid_2fa');
    }

    // Sukses: session + csrf, reset lockout, audit (tanpa kode/password)
    const sessionId = randomToken(32);
    const csrfToken = randomToken(32);
    const expiresAt = this.#iso(nowMs + this.#sessionTtlMs);
    this.#h.tx(() => {
      this.#stmts.insSession.run(sessionId, row.id, nowIso, expiresAt, csrfToken);
      this.#stmts.loginOk.run(nowIso, row.id);
    });
    this.#audit('LOGIN_SUCCESS', { actor: u, userId: row.id, role: row.role, ip, result: 'ok' });

    const maxAge = Math.round(this.#sessionTtlMs / 1000);
    const sessionCookie = `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    const csrfCookie = `${CSRF_COOKIE}=${csrfToken}; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    return {
      ok: true,
      sessionId,
      sessionCookie,
      csrfCookie,
      csrfToken,
      user: this.#userFromRow(row),
    };
  }

  /**
   * Session valid → {user, csrfToken, expiresAt, sessionId}; expired/revoked/
   * user hilang → null. User dibaca live (role/status selalu fresh).
   */
  getSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    const row = this.#stmts.getSession.get(sessionId);
    if (!row || row.revoked) return null;
    if (Date.parse(row.expires_at) <= this.#now()) return null;
    const userRow = this.#stmts.getUserByIdFull.get(row.user_id);
    if (!userRow) return null;
    return {
      user: this.#userFromRow(userRow),
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      sessionId: row.id,
    };
  }

  /** CSRF double-submit bandingkan dengan session.csrfToken (konstanta-waktu). */
  validateCsrf(session, provided) {
    if (!session || typeof provided !== 'string' || provided === '') return false;
    return safeEqualStr(session.csrfToken, provided);
  }

  /** validateCsrf yang gagal → VmPanelError PERMISSION_DENIED. */
  requireCsrf(session, provided) {
    if (!this.validateCsrf(session, provided)) {
      throw new VmPanelError(PERMISSION_DENIED, 'CSRF token tidak valid');
    }
    return true;
  }

  /** Logout: hapus row session + audit LOGOUT. */
  logout(sessionId, { ip } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, existed: false };
    const row = this.#stmts.getSession.get(sessionId);
    if (!row) return { ok: true, existed: false };
    this.#stmts.delSession.run(sessionId);
    this.#audit('LOGOUT', { userId: row.user_id, ip, result: 'ok' });
    return { ok: true, existed: true };
  }

  /** Hapus semua session expired → jumlah baris terhapus. */
  cleanupExpired() {
    const info = this.#stmts.delExpiredSessions.run(this.#iso(this.#now()));
    return Number(info.changes ?? 0);
  }

  /** Daftar user tanpa kredensial (tanpa hash/TOTP) — untuk halaman /users. */
  listUsers() {
    return this.#stmts.listUsers.all().map((r) => ({
      userId: r.id,
      username: r.username,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    }));
  }

  /** Akses PermissionManager internal (untuk server: checkPermission, dsb). */
  get perm() {
    return this.#perm;
  }

  /** Tutup koneksi DB (panel + permission manager). */
  close() {
    try {
      this.#perm.close();
    } finally {
      this.#h.close();
    }
  }
}
