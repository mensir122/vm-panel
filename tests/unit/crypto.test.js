// tests/unit/crypto.test.js — scrypt, AES-256-GCM, base32, TOTP RFC-6238 (node:test)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scryptHash,
  scryptVerify,
  aesEncrypt,
  aesDecrypt,
  pbkdf2Hex,
  deriveKeys,
  randomToken,
  base32Decode,
  totpGenerate,
  totpVerify,
} from '../../lib/crypto.js';

describe('scrypt', () => {
  test('roundtrip + params N=2^17 r=8 p=1; password salah gagal', () => {
    const stored = scryptHash('s3cret-password');
    assert.equal(stored.params.N, 131072);
    assert.equal(stored.params.r, 8);
    assert.equal(stored.params.p, 1);
    assert.equal(stored.hash.length, 128); // 64 byte hex
    assert.ok(/^[0-9a-f]{32}$/.test(stored.salt));

    assert.equal(scryptVerify('s3cret-password', stored), true);
    assert.equal(scryptVerify('wrong-password', stored), false);
  });

  test('salt acak per panggilan', () => {
    const a = scryptHash('same');
    const b = scryptHash('same');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
  });
});

describe('AES-256-GCM', () => {
  test('roundtrip', () => {
    const key = Buffer.alloc(32, 7);
    const env = aesEncrypt(key, 'top secret payload');
    assert.ok(env.iv && env.tag && env.ct);
    assert.equal(aesDecrypt(key, env), 'top secret payload');
  });

  test('tamper ct → throw DECRYPT_FAIL', () => {
    const key = Buffer.alloc(32, 7);
    const env = aesEncrypt(key, 'payload');
    // tamper satu byte ciphertext
    const ctBuf = Buffer.from(env.ct, 'base64');
    ctBuf[0] ^= 0x01;
    const tampered = { ...env, ct: ctBuf.toString('base64') };
    assert.throws(
      () => aesDecrypt(key, tampered),
      (e) => e.code === 'DECRYPT_FAIL',
    );
  });

  test('kunci salah → throw', () => {
    const env = aesEncrypt(Buffer.alloc(32, 1), 'payload');
    assert.throws(() => aesDecrypt(Buffer.alloc(32, 2), env), /DECRYPT_FAIL|decryption failed/i);
  });

  test('kunci invalid → KEY_INVALID', () => {
    assert.throws(() => aesEncrypt(Buffer.alloc(16, 1), 'x'), (e) => e.code === 'KEY_INVALID');
  });
});

describe('pbkdf2 & key derivation', () => {
  test('pbkdf2Hex default 600k iterasi, 32 byte hex', () => {
    const h = pbkdf2Hex('master', 'salt');
    assert.equal(h.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(h));
    // deterministik
    assert.equal(h, pbkdf2Hex('master', 'salt'));
    assert.notEqual(h, pbkdf2Hex('master', 'salt2'));
  });

  test('deriveKeys → kEnc != kExport (label beda di salt)', () => {
    const { kEnc, kExport } = deriveKeys('test-master-key-do-not-use', 'filesalt');
    assert.equal(kEnc.length, 32);
    assert.equal(kExport.length, 32);
    assert.notDeepEqual(kEnc, kExport);
    // deterministik
    const again = deriveKeys('test-master-key-do-not-use', 'filesalt');
    assert.deepEqual(kEnc, again.kEnc);
  });
});

describe('randomToken', () => {
  test('32 byte default → 64 hex char, unik', () => {
    const t1 = randomToken();
    assert.equal(t1.length, 64);
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.notEqual(t1, randomToken());
  });
});

describe('base32Decode', () => {
  test('vektor: MFRGGZDFMZTWQ2LK → "abcdefghij" (RFC 4648, 10 byte)', () => {
    // RFC 4648: 16 char tanpa pad = 80 bit = 10 byte
    assert.equal(base32Decode('MFRGGZDFMZTWQ2LK').toString('utf8'), 'abcdefghij');
    // subset 7 byte 'abcdefg' = 12 char data + pad '====' (sisa bit nol)
    assert.deepEqual(
      base32Decode('MFRGGZDFMZTW===='),
      Buffer.from([0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67]),
    );
  });

  test('RFC 4648 test vectors', () => {
    assert.equal(base32Decode('').toString('utf8'), '');
    assert.equal(base32Decode('MY======').toString('utf8'), 'f');
    assert.equal(base32Decode('MZXQ====').toString('utf8'), 'fo');
    assert.equal(base32Decode('MZXW6===').toString('utf8'), 'foo');
    assert.equal(base32Decode('MZXW6YQ=').toString('utf8'), 'foob');
    assert.equal(base32Decode('MZXW6YTB').toString('utf8'), 'fooba');
    assert.equal(base32Decode('MZXW6YTBOI======').toString('utf8'), 'foobar');
  });

  test('case-insensitive, strip = spasi hyphen', () => {
    assert.equal(base32Decode('mfrggzdfmztwq2lk').toString('utf8'), 'abcdefghij');
    assert.equal(base32Decode('MFRG GZDF-MZTWQ2==LK').toString('utf8'), 'abcdefghij');
  });

  test('Crockford: digit 0/1/8/9 → route Crockford; alias O→0 I/L→1', () => {
    // '91' mengandung 9 (ilegal di RFC 4648) → alphabet Crockford
    assert.deepEqual(base32Decode('91'), Buffer.from([0x48])); // 9=01001,0=00000 → 0x48 'H'
    // 'AB' pure-letter → RFC 4648 (A=0, B=1) — BUKAN Crockford
    assert.deepEqual(base32Decode('AB'), Buffer.from([0x00]));
    // 'A0' mengandung digit 0 → Crockford: A=10(01010), 0=0(00000) → 01010000=0x50 'P'
    assert.deepEqual(base32Decode('A0'), Buffer.from([0x50]));
    assert.equal(base32Decode('JBSWY3DPEHPK3PXP').toString('utf8', 0, 6), 'Hello!');
  });

  test('karakter ilegal → throw', () => {
    assert.throws(() => base32Decode('ABC!DEF'), /illegal base32/i);
    assert.throws(() => base32Decode('ABC1DEFU'), /illegal base32/i); // U tidak ada di Crockford
  });
});

describe('TOTP RFC-6238 (HMAC-SHA1, secret ASCII "12345678901234567890")', () => {
  // base32 dari "12345678901234567890" = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  test('T=59, 8 digit → 94287082', () => {
    assert.equal(totpGenerate(SECRET, { digits: 8, t: 59 }), '94287082');
  });

  test('T=1111111109, 6 digit → 081804 (leading zero preserved)', () => {
    assert.equal(totpGenerate(SECRET, { t: 1111111109 }), '081804');
  });

  test('T=1234567890, 6 digit → 005924', () => {
    assert.equal(totpGenerate(SECRET, { t: 1234567890 }), '005924');
  });

  test('6 digit pada T=59 → 287082', () => {
    assert.equal(totpGenerate(SECRET, { t: 59 }), '287082');
  });

  test('totpVerify benar/salah, window default 1, leading zero', () => {
    assert.equal(totpVerify(SECRET, '94287082', { digits: 8, t: 59 }), true);
    assert.equal(totpVerify(SECRET, '081804', { t: 1111111109 }), true);
    assert.equal(totpVerify(SECRET, '005924', { t: 1234567890 }), true);
    assert.equal(totpVerify(SECRET, '94287083', { digits: 8, t: 59 }), false);
    assert.equal(totpVerify(SECRET, 'abc', { t: 59 }), false);
    // window: kode dari step tetangga diterima
    assert.equal(totpVerify(SECRET, '287082', { t: 59 + 30 }), true);
    assert.equal(totpVerify(SECRET, '287082', { t: 59 + 90, window: 1 }), false);
  });
});
