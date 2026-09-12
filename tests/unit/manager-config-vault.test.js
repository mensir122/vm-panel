// tests/unit/manager-config-vault.test.js — pengujian unit end-to-end untuk
// endpoint brankas (secrets), koper konfigurasi, env mapping, dan hooks di Manager API.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager } from '../../manager/index.js';
import { ManagerClient } from '../../lib/api-client.js';
import { SecretManager } from '../../manager/secret_manager/index.js';

// F4: projectId kini divalidasi isValidId('prj_') SEBELUM path.join —
// fixture wajib format kanonik Crockford base32 (10 char, tanpa I/L/O/U).
const PID = 'prj_TESTKP3R01';

function randomHighPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

describe('Manager API — Config & Brankas Endpoints', () => {
  let rootDir;
  let manager;
  let client;

  before(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'vmpanel-mgr-cv-'));
    for (const d of ['data', 'workspaces', 'runtime/pid', 'runtime/sockets', 'secrets']) {
      mkdirSync(join(rootDir, d), { recursive: true });
    }

    const port = randomHighPort();
    manager = new Manager({
      rootDir,
      token: 'test-token-cv',
      config: {
        manager: { apiPort: port, hostMode: 'dev' },
      },
    });
    await manager.start();
    client = new ManagerClient({ port, token: 'test-token-cv' });
  });

  after(async () => {
    if (manager && manager.running) {
      await manager.stop();
    }
    try {
      rmSync(rootDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('1. GET /secrets sebelum inisialisasi mengembalikan 404 NOT_FOUND', async () => {
    await assert.rejects(
      async () => client.request('GET', '/secrets'),
      (err) => err.code === 'NOT_FOUND',
    );
  });

  test('2. POST /secrets/init menginisialisasi brankas', async () => {
    const res = await client.request('POST', '/secrets/init', {
      body: { masterKey: 'minimal-32-karakter-kunci-rahasia-uji' },
    });
    assert.equal(res.initialized, true);
    assert.equal(res.vaultFile, 'secrets/vault.enc');
  });

  test('3. GET /secrets setelah inisialisasi mengembalikan array kosong', async () => {
    const res = await client.request('GET', '/secrets');
    assert.ok(Array.isArray(res.secrets));
  });

  test('4. POST /projects/:id/config menyimpan file koper konfigurasi', async () => {
    const content = Buffer.from('server_setting=123\nport=9000').toString('base64');
    const res = await client.request('POST', `/projects/${PID}/config`, {
      body: { filename: 'app.conf', contentBase64: content },
    });
    assert.equal(res.projectId, PID);
    assert.equal(res.filename, 'app.conf');
    assert.ok(res.sizeBytes > 0);
    assert.ok(res.sha256);
  });

  test('5. GET /projects/:id/config mendaftar file koper', async () => {
    const res = await client.request('GET', `/projects/${PID}/config`);
    assert.ok(Array.isArray(res.configs));
    assert.equal(res.configs.length, 1);
    assert.equal(res.configs[0].filename, 'app.conf');
  });

  test('6. GET /projects/:id/config/:filename mengambil isi file', async () => {
    const res = await client.request('GET', `/projects/${PID}/config/app.conf`);
    assert.equal(res.filename, 'app.conf');
    assert.ok(res.contentBase64);
    const decoded = Buffer.from(res.contentBase64, 'base64').toString('utf8');
    assert.ok(decoded.includes('server_setting=123'));
  });

  test('7. Hapus config dua tahap (remove-request → remove)', async () => {
    // Fase 1: minta token konfirmasi
    const reqRes = await client.request('POST', `/projects/${PID}/config/app.conf/remove-request`);
    assert.ok(reqRes.confirmToken);

    // Fase 2: eksekusi hapus dengan token
    const delRes = await client.request('POST', `/projects/${PID}/config/app.conf/remove`, {
      body: { confirmToken: reqRes.confirmToken },
    });
    assert.equal(delRes.removed, true);

    // Verifikasi daftar config kosong kembali
    const check = await client.request('GET', `/projects/${PID}/config`);
    assert.equal(check.configs.length, 0);
  });

  test('8. POST /projects/:id/env memetakan variabel rahasia', async () => {
    const res = await client.request('POST', `/projects/${PID}/env`, {
      body: { envName: 'BOT_TOKEN', secretName: 'tg_bot_token' },
    });
    assert.equal(res.projectId, PID);
    assert.equal(res.envName, 'BOT_TOKEN');
    assert.equal(res.secretName, 'tg_bot_token');
  });

  test('9. GET /projects/:id/env mengambil daftar variabel rahasia', async () => {
    const res = await client.request('GET', `/projects/${PID}/env`);
    assert.ok(Array.isArray(res.env));
    assert.equal(res.env.length, 1);
    assert.equal(res.env[0].envName, 'BOT_TOKEN');
  });

  test('10. Hapus env dua tahap (remove-request → remove)', async () => {
    const reqRes = await client.request('POST', `/projects/${PID}/env/BOT_TOKEN/remove-request`);
    assert.ok(reqRes.confirmToken);

    const delRes = await client.request('POST', `/projects/${PID}/env/BOT_TOKEN/remove`, {
      body: { confirmToken: reqRes.confirmToken },
    });
    assert.equal(delRes.removed, true);

    const check = await client.request('GET', `/projects/${PID}/env`);
    assert.equal(check.env.length, 0);
  });

  test('11. PUT /projects/:id/hook menyimpan konfigurasi startup hook', async () => {
    const res = await client.request('PUT', `/projects/${PID}/hook`, {
      body: {
        url: 'http://127.0.0.1:20127/api/settings/database',
        bodyFile: '9router-backup.json',
        secretFields: [{ fieldName: 'password', secretName: 'panel_admin_pass' }],
      },
    });
    assert.equal(res.projectId, PID);
    assert.equal(res.hook.url, 'http://127.0.0.1:20127/api/settings/database');
  });

  test('12. GET /projects/:id/hook membaca konfigurasi hook', async () => {
    const res = await client.request('GET', `/projects/${PID}/hook`);
    assert.ok(res.hook);
    assert.equal(res.hook.url, 'http://127.0.0.1:20127/api/settings/database');
  });

  test('13. POST /projects/:id/hook/test menguji koneksi (graceful saat port offline)', async () => {
    const res = await client.request('POST', `/projects/${PID}/hook/test`);
    assert.equal(res.ok, false); // Port 20127 offline, hasil graceful ok: false
    assert.equal(res.attempts, 1);
  });

  test('14. Hapus hook dua tahap (remove-request → remove)', async () => {
    const reqRes = await client.request('POST', `/projects/${PID}/hook/remove-request`);
    assert.ok(reqRes.confirmToken);

    const delRes = await client.request('POST', `/projects/${PID}/hook/remove`, {
      body: { confirmToken: reqRes.confirmToken },
    });
    assert.equal(delRes.removed, true);

    const check = await client.request('GET', `/projects/${PID}/hook`);
    assert.equal(check.hook, null);
  });

  // ── Regresi F4 (bug-hunt god-mode lane M-A) ─────────────────────────────

  test('15. F4: setSecret memakai signature kanonik vault.set(name,value,opts)', async () => {
    const sm = manager.secretManager;
    const res = sm.setSecret({ name: 'tg_bot_token', value: 'super-secret-123' });
    assert.equal(res.name, 'tg_bot_token');
    const list = sm.listSecrets();
    assert.ok(list.some((s) => s.name === 'tg_bot_token'), 'metadata tersimpan');
    assert.equal(sm.getSecretValue('tg_bot_token'), 'super-secret-123');
    // listSecrets TIDAK PERNAH memuat nilai
    assert.ok(!JSON.stringify(list).includes('super-secret-123'));
  });

  test('16. F4: projectId non-kanonik/traversal ditolak VALIDATION sebelum path.join', () => {
    const sm = manager.secretManager;
    for (const bad of ['prj_test_koper', '../../etc', 'prj_BADIO00000', '']) {
      assert.throws(
        () => sm.listConfigs(bad),
        (e) => e?.code === 'VALIDATION',
        `listConfigs('${bad}') harus VALIDATION`,
      );
      assert.throws(
        () => sm.listProjectEnv(bad),
        (e) => e?.code === 'VALIDATION',
        `listProjectEnv('${bad}') harus VALIDATION`,
      );
      assert.throws(
        () => sm.getProjectHook(bad),
        (e) => e?.code === 'VALIDATION',
        `getProjectHook('${bad}') harus VALIDATION`,
      );
    }
  });

  test('17. F4: nama file config tidak aman ditolak VALIDATION', () => {
    const sm = manager.secretManager;
    const content = Buffer.from('x').toString('base64');
    for (const bad of ['../evil', '..\\..\\windows', 'a/b', 'a\\b', '.hidden', 'nama..json', '']) {
      assert.throws(
        () => sm.saveConfig(PID, { filename: bad, contentBase64: content }),
        (e) => e?.code === 'VALIDATION',
        `saveConfig('${bad}') harus VALIDATION`,
      );
      assert.throws(
        () => sm.getConfig(PID, bad),
        (e) => e?.code === 'VALIDATION',
        `getConfig('${bad}') harus VALIDATION`,
      );
      assert.throws(
        () => sm.removeConfig(PID, bad),
        (e) => e?.code === 'VALIDATION',
        `removeConfig('${bad}') harus VALIDATION`,
      );
    }
  });

  test('18. F4: _getKey32 tanpa masterKey/env → VAULT_CONFIG (bukan konstanta default)', () => {
    const saved = process.env.VPANEL_MASTER_KEY;
    delete process.env.VPANEL_MASTER_KEY;
    const dir = mkdtempSync(join(tmpdir(), 'vmpanel-k32-'));
    try {
      const sm = new SecretManager({ rootDir: dir }); // tanpa masterKey
      assert.throws(
        () => sm._getKey32(),
        (e) => e?.code === 'VAULT_CONFIG',
        '_getKey32 tanpa kunci harus VAULT_CONFIG',
      );
      assert.throws(
        () => sm.saveConfig(PID, { filename: 'ok.conf', contentBase64: 'aGk=' }),
        (e) => e?.code === 'VAULT_CONFIG',
      );
    } finally {
      if (saved !== undefined) process.env.VPANEL_MASTER_KEY = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
