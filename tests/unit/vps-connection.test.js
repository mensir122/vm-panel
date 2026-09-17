import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConnKey,
  encryptConnection,
  decryptConnection,
  parseSshCommand,
  updateSshConfig,
} from '../../scripts/vps-connection.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('VPS Connection Helper & Cryptography', () => {
  const dummyMasterKey = 'a-super-secret-key-with-sufficient-entropy-12345';
  const dummyConn = {
    provider: 'tmate',
    ssh_cmd: 'ssh runner123@sgp1.tmate.io -p 22',
    run_id: '12345678',
    created_at: '2026-09-14T10:00:00Z',
  };

  it('getConnKey menghasilkan Buffer 32-byte yang konsisten', () => {
    const key1 = getConnKey(dummyMasterKey);
    const key2 = getConnKey(dummyMasterKey);
    assert.strictEqual(key1.length, 32);
    assert.deepStrictEqual(key1, key2);

    assert.throws(() => getConnKey(''), /masterKey/);
    assert.throws(() => getConnKey(null), /masterKey/);
  });

  it('encryptConnection dan decryptConnection roundtrip sempurna', () => {
    const enc = encryptConnection(dummyConn, dummyMasterKey);
    assert.ok(enc.iv);
    assert.ok(enc.tag);
    assert.ok(enc.ct);

    const decrypted = decryptConnection(enc, dummyMasterKey);
    assert.deepStrictEqual(decrypted, dummyConn);
  });

  it('decryptConnection gagal jika ciphertext atau tag diubah (anti-tamper)', () => {
    const enc = encryptConnection(dummyConn, dummyMasterKey);
    const tampered = { ...enc, ct: Buffer.from('corrupted-data').toString('base64') };

    assert.throws(() => decryptConnection(tampered, dummyMasterKey), {
      code: 'DECRYPT_FAIL',
    });
  });

  it('decryptConnection gagal jika menggunakan master key yang salah', () => {
    const enc = encryptConnection(dummyConn, dummyMasterKey);
    const wrongKey = 'completely-wrong-master-key-000000000000000000';

    assert.throws(() => decryptConnection(enc, wrongKey), {
      code: 'DECRYPT_FAIL',
    });
  });

  it('parseSshCommand memformat perintah dengan flags keamanan dan private key', () => {
    const parsed = parseSshCommand('ssh foo@bar.tmate.io', {
      keyPath: '/custom/path/id_ed25519',
    });

    assert.strictEqual(parsed.command, 'ssh');
    assert.ok(parsed.args.includes('-o'));
    assert.ok(parsed.args.includes('StrictHostKeyChecking=no'));
    assert.ok(parsed.args.includes('UserKnownHostsFile=/dev/null'));
    assert.ok(parsed.args.includes('-i'));
    assert.ok(parsed.args.includes('/custom/path/id_ed25519'));
    assert.ok(parsed.args.includes('foo@bar.tmate.io'));
  });

  it('parseSshCommand melempar error untuk input kosong', () => {
    assert.throws(() => parseSshCommand(''), /rawSshCmd/);
    assert.throws(() => parseSshCommand(null), /rawSshCmd/);
  });

  it('updateSshConfig menulis dan memperbarui host vpanel-vps secara idempotent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-ssh-test-'));
    try {
      const configPath = path.join(tmpDir, 'config');
      const conn1 = { host: 'bore.pub', port: 12345, user: 'runner' };

      const content1 = updateSshConfig(conn1, { configPath, sshDir: tmpDir });
      assert.ok(content1.includes('Host vpanel-vps'));
      assert.ok(content1.includes('HostName bore.pub'));
      assert.ok(content1.includes('Port 12345'));
      assert.ok(content1.includes('User runner'));

      // Pembaruan port baru (idempotent, tanpa duplikasi blok)
      const conn2 = { host: 'bore.pub', port: 54321, user: 'runner' };
      const content2 = updateSshConfig(conn2, { configPath, sshDir: tmpDir });
      assert.ok(content2.includes('Port 54321'));
      assert.strictEqual(content2.indexOf('Host vpanel-vps'), content2.lastIndexOf('Host vpanel-vps'));

      // Parsing otomatis dari ssh_cmd
      const conn3 = { ssh_cmd: 'ssh runner@bore.pub -p 9999' };
      const content3 = updateSshConfig(conn3, { configPath, sshDir: tmpDir });
      assert.ok(content3.includes('Port 9999'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
