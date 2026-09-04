// lib/crypto.js — kripto bawaan node:crypto (DESIGN §12.3):
// scrypt N=2^17 r=8 p=1 (maxmem 256MB), AES-256-GCM, PBKDF2-SHA256 600k,
// base32 (RFC 4648 + Crockford), TOTP RFC-6238 (HMAC-SHA1).
import crypto from 'node:crypto';

const SCRYPT = { N: 131072, r: 8, p: 1 }; // 2^17
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const PBKDF2_ITERATIONS = 600000;

function cryptoError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Normalisasi kunci: Buffer 32-byte atau string hex 64-char. */
function normalizeKey32(key) {
  if (Buffer.isBuffer(key)) {
    if (key.length !== 32) {
      throw cryptoError('KEY_INVALID', 'key must be 32 bytes');
    }
    return key;
  }
  if (typeof key === 'string' && /^[0-9a-fA-F]{64}$/.test(key)) {
    return Buffer.from(key, 'hex');
  }
  throw cryptoError('KEY_INVALID', 'key must be a 32-byte Buffer or 64-char hex string');
}

/**
 * Hash password: scrypt N=2^17, r=8, p=1, maxmem 256MB, 64-byte key.
 * Return {salt(hex), hash(hex), params}.
 */
export function scryptHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return {
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
  };
}

/** Verifikasi password dengan timingSafeEqual (konstanta-waktu). */
export function scryptVerify(password, stored) {
  try {
    const salt = Buffer.from(stored.salt, 'hex');
    const expected = Buffer.from(stored.hash, 'hex');
    if (expected.length === 0) return false;
    const { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = stored.params ?? {};
    const computed = crypto.scryptSync(String(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return crypto.timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

/**
 * AES-256-GCM encrypt. Return envelope {iv, tag, ct} base64.
 * key32: Buffer 32-byte atau hex string.
 */
export function aesEncrypt(key32, plaintext) {
  const key = normalizeKey32(key32);
  const iv = crypto.randomBytes(12);
  const data = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(String(plaintext), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * AES-256-GCM decrypt envelope {iv, tag, ct} (base64) → string utf8.
 * Tag tamper/corrupt → throw DECRYPT_FAIL.
 */
export function aesDecrypt(key32, envelope) {
  const key = normalizeKey32(key32);
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw cryptoError(
      'DECRYPT_FAIL',
      'AES-256-GCM decryption failed: tag mismatch (envelope tampered or corrupted)',
    );
  }
}

/** PBKDF2-SHA256 → hex. Default 600.000 iterasi, 32 byte. */
export function pbkdf2Hex(secret, salt, iterations = PBKDF2_ITERATIONS, len = 32) {
  return crypto
    .pbkdf2Sync(String(secret), String(salt), iterations, len, 'sha256')
    .toString('hex');
}

function pbkdf2Buf(secret, salt, label) {
  // label di-append ke salt sebagai pemisah purpose (info beda per tujuan)
  return crypto.pbkdf2Sync(
    String(secret),
    Buffer.concat([Buffer.from(String(salt), 'utf8'), Buffer.from(label, 'utf8')]),
    PBKDF2_ITERATIONS,
    32,
    'sha256',
  );
}

/** Derive kunci per-purpose dari master key. Return Buffer 32-byte. */
export function deriveKey(masterKeyStr, salt, label) {
  return pbkdf2Buf(masterKeyStr, salt, label);
}

/** {kEnc, kExport} — label 'enc' / 'export' di salt. */
export function deriveKeys(masterKeyStr, salt) {
  return {
    kEnc: pbkdf2Buf(masterKeyStr, salt, 'enc'),
    kExport: pbkdf2Buf(masterKeyStr, salt, 'export'),
  };
}

/** Token acak hex. Default 32 byte → 64 char hex. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// base32 decode — RFC 4648 (A-Z, 2-7) + toleransi Crockford (0-9, tanpa I/L/O/U)
// ---------------------------------------------------------------------------

const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const RFC4648_MAP = new Map();
[...RFC4648_ALPHABET].forEach((ch, i) => RFC4648_MAP.set(ch, i));

const CROCKFORD_MAP = new Map();
[...CROCKFORD_ALPHABET].forEach((ch, i) => CROCKFORD_MAP.set(ch, i));
// alias transkripsi Crockford: O→0, I→1, L→1
CROCKFORD_MAP.set('O', 0);
CROCKFORD_MAP.set('I', 1);
CROCKFORD_MAP.set('L', 1);

/**
 * Decode base32 → Buffer. Strip '=', spasi, hyphen; case-insensitive.
 * Heuristik alphabet: jika mengandung 0/1/8/9 (ilegal di RFC 4648) →
 * Crockford; selain itu → RFC 4648. Karakter ilegal → throw.
 */
export function base32Decode(input) {
  if (typeof input !== 'string') {
    throw cryptoError('BASE32_INVALID_INPUT', 'base32Decode expects a string');
  }
  const s = input.toUpperCase().replace(/[=\s-]/g, '');
  if (s.length === 0) return Buffer.alloc(0);

  const useCrockford = /[0189]/.test(s);
  const map = useCrockford ? CROCKFORD_MAP : RFC4648_MAP;

  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const v = map.get(ch);
    if (v === undefined) {
      throw cryptoError('BASE32_ILLEGAL_CHAR', `illegal base32 character: '${ch}'`);
    }
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// TOTP RFC-6238 (HMAC-SHA1, dynamic truncation, counter = floor(t/step))
// ---------------------------------------------------------------------------

function hotpTruncate(keyBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return bin;
}

function resolveTime(t) {
  if (t === undefined || t === null) return Date.now() / 1000;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) {
    throw cryptoError('TOTP_INVALID_TIME', 'totp: invalid time t');
  }
  return n;
}

/** Generate kode TOTP (default 6 digit, step 30s) RFC-6238. */
export function totpGenerate(secretBase32, { timeStepSec = 30, digits = 6, t } = {}) {
  if (!Number.isInteger(timeStepSec) || timeStepSec <= 0) {
    throw cryptoError('TOTP_INVALID_STEP', 'totp: timeStepSec must be a positive integer');
  }
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) {
    throw cryptoError('TOTP_INVALID_DIGITS', 'totp: digits must be 1..10');
  }
  const key = base32Decode(secretBase32);
  const counter = Math.floor(resolveTime(t) / timeStepSec);
  const code = (hotpTruncate(key, counter) % 10 ** digits).toString();
  return code.padStart(digits, '0');
}

/**
 * Verifikasi kode TOTP dengan jendela ±window (default 1 step).
 * Komparasi konstanta-waktu (timingSafeEqual); leading zero aman
 * (string comparison, bukan parseInt).
 */
export function totpVerify(secretBase32, code, { timeStepSec = 30, digits = 6, window = 1, t } = {}) {
  if (typeof code !== 'string' && typeof code !== 'number') return false;
  const candidate = String(code).trim();
  if (!/^\d+$/.test(candidate)) return false;
  if (!Number.isInteger(timeStepSec) || timeStepSec <= 0) {
    throw cryptoError('TOTP_INVALID_STEP', 'totp: timeStepSec must be a positive integer');
  }
  const key = base32Decode(secretBase32);
  const counter = Math.floor(resolveTime(t) / timeStepSec);
  for (let w = -window; w <= window; w++) {
    const expected = (
      hotpTruncate(key, counter + w) % 10 ** digits
    ).toString().padStart(digits, '0');
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}
