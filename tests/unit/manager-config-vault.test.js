// tests/unit/manager-config-vault.test.js — pengujian unit end-to-end untuk
// endpoint brankas (secrets), koper konfigurasi, env mapping, dan hooks di Manager API.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager } from '../../manager/index.js';
import { ManagerClient } from '../../lib/api-client.js';

const PID = 'prj_test_koper';

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
});
