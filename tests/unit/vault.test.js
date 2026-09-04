// tests/unit/vault.test.js — encrypted store, scope enforcement, tamper (node:test)
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault.js';

const tmpRoot = join(tmpdir(), 'vmpanel-vault-test');
mkdirSync(tmpRoot, { recursive: true });
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpRoot, 'run-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Vault — set/get/rotate/remove/list', () => {
  test('set → get roundtrip; persist ke file; reload tetap terbaca', () => {
    const p = join(dir, 'vault.enc');
    const v = new Vault({ filePath: p, masterKey: 'test-master-key-do-not-use' });
    v.set('api_key', 'supersecret123', { projectScope: 'proj-a' });

    assert.equal(v.get('api_key', { projectScope: 'proj-a' }), 'supersecret123');

    // reload dari disk
    const v2 = new Vault({ filePath: p, masterKey: 'test-master-key-do-not-use' });
    assert.equal(v2.get('api_key', { projectScope: 'proj-a' }), 'supersecret123');
  });

  test('list() metadata TANPA value', () => {
    const v = new Vault({ filePath: join(dir, 'vault.enc'), masterKey: 'k' });
    v.set('token_x', 'VALUE-MUST-NOT-LEAK', { projectScope: 'p1', expiresAt: '2030-01-01' });
    const items = v.list();
    assert.equal(items.length, 1);
    const m = items[0];
    assert.equal(m.name, 'token_x');
    assert.equal(m.projectScope, 'p1');
    assert.equal(m.expiresAt, '2030-01-01');
    assert.ok(m.createdAt);
    assert.ok(!('value' in m), 'list tidak boleh berisi value');
    assert.equal(JSON.stringify(items).includes('VALUE-MUST-NOT-LEAK'), false);
  });

  test('rotate: value + rotatedAt berubah, createdAt tetap', async () => {
    const v = new Vault({ filePath: join(dir, 'vault.enc'), masterKey: 'k' });
    v.set('db_pass', 'old-pass');
    const before = v.list().find((m) => m.name === 'db_pass');
    await new Promise((r) => setTimeout(r, 5));
    v.rotate('db_pass', 'new-pass');
    const after = v.list().find((m) => m.name === 'db_pass');
    assert.equal(v.get('db_pass'), 'new-pass');
    assert.equal(after.createdAt, before.createdAt);
    assert.notEqual(after.rotatedAt, before.rotatedAt);
    assert.ok(after.rotatedAt);
  });

  test('remove: menghapus; get setelahnya → SECRET_NOT_FOUND', () => {
    const v = new Vault({ filePath: join(dir, 'vault.enc'), masterKey: 'k' });
    v.set('tmp', 'v');
    v.remove('tmp');
    assert.equal(v.list().length, 0);
    assert.throws(
      () => v.get('tmp'),
      (e) => e.code === 'SECRET_NOT_FOUND',
    );
    assert.throws(() => v.remove('tmp'), (e) => e.code === 'SECRET_NOT_FOUND');
    assert.throws(() => v.rotate('tmp', 'x'), (e) => e.code === 'SECRET_NOT_FOUND');
  });

  test('scope enforcement: mismatch → SECRET_NOT_FOUND (tanpa bocor bedanya)', () => {
    const v = new Vault({ filePath: join(dir, 'vault.enc'), masterKey: 'k' });
    v.set('scoped', 'val', { projectScope: 'proj-a' });

    // nama ada tapi scope salah → kode error + pola pesan sama
    // dengan nama tak ada (generik, tidak membocorkan alasan)
    const e1 = (() => {
      try {
        v.get('scoped', { projectScope: 'proj-b' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    const e2 = (() => {
      try {
        v.get('does-not-exist', { projectScope: 'proj-a' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    assert.ok(e1 && e2, 'kedua kasus harus throw');
    assert.equal(e1.code, 'SECRET_NOT_FOUND');
    assert.equal(e2.code, 'SECRET_NOT_FOUND');
    assert.match(e1.message, /^secret not found: /);
    assert.match(e2.message, /^secret not found: /);

    // scope benar → sukses; scope default (null) juga berbeda dari 'proj-a'
    assert.equal(v.get('scoped', { projectScope: 'proj-a' }), 'val');
    assert.throws(() => v.get('scoped'), (e) => e.code === 'SECRET_NOT_FOUND');
  });
});

describe('Vault — at-rest & tamper', () => {
  test('value TIDAK tersimpan plaintext di file', () => {
    const p = join(dir, 'vault.enc');
    const v = new Vault({ filePath: p, masterKey: 'k1' });
    v.set('leak_test', 'PLAINTEXT-CANARY-VALUE');
    const raw = readFileSync(p, 'utf8');
    assert.equal(raw.includes('PLAINTEXT-CANARY-VALUE'), false);
    assert.equal(raw.includes('leak_test'), false);
    // struktur envelope
    const obj = JSON.parse(raw);
    assert.ok(obj.salt);
    assert.ok(obj.envelope.iv && obj.envelope.tag && obj.envelope.ct);
  });

  test('file tamper (ct) → throw saat load', () => {
    const p = join(dir, 'vault.enc');
    const v = new Vault({ filePath: p, masterKey: 'k1' });
    v.set('s', 'v');
    v.remove('s'); // pastikan file tertulis

    const obj = JSON.parse(readFileSync(p, 'utf8'));
    const ctBuf = Buffer.from(obj.envelope.ct, 'base64');
    ctBuf[0] ^= 0xff;
    obj.envelope.ct = ctBuf.toString('base64');
    writeFileSync(p, JSON.stringify(obj));

    assert.throws(
      () => new Vault({ filePath: p, masterKey: 'k1' }),
      (e) => e.code === 'VAULT_DECRYPT_FAIL',
    );
  });

  test('dua Vault instance kunci beda → gagal baca', () => {
    const p = join(dir, 'vault.enc');
    const v1 = new Vault({ filePath: p, masterKey: 'key-alpha' });
    v1.set('secret', 'v1');

    assert.throws(
      () => new Vault({ filePath: p, masterKey: 'key-beta' }),
      (e) => e.code === 'VAULT_DECRYPT_FAIL',
    );
  });

  test('atomic write: tidak menyisakan file tmp', () => {
    const p = join(dir, 'vault.enc');
    const v = new Vault({ filePath: p, masterKey: 'k' });
    v.set('a', '1');
    v.set('b', '2');
    v.rotate('a', '3');
    const leftovers = existsSync(p + '.tmp');
    assert.equal(leftovers, false);
    // tidak ada file .tmp-* tersisa di dir
    const names = readdirSync(dir).filter((n) => n.includes('.tmp'));
    assert.deepEqual(names, []);
  });
});
