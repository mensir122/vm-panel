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

  // ── L5b: jalur input NILAI secret (POST/PUT + hapus dua-fase) ─────────────
  const SEKRET = 'SEKRITPALSUxyz-uji-4096';

  test('19. POST /secrets/:name membuat secret — respons metadata TANPA nilai', async () => {
    const res = await client.request('POST', '/secrets/OPENAI_KEY', {
      body: { value: SEKRET, projectScope: null },
    });
    assert.equal(res.name, 'OPENAI_KEY');
    assert.equal(res.projectScope, '');
    assert.equal(typeof res.updatedAt, 'string');
    assert.ok(!JSON.stringify(res).includes(SEKRET), 'nilai haram muncul di respons');

    const listed = await client.request('GET', '/secrets');
    assert.ok(!JSON.stringify(listed).includes(SEKRET), 'nilai haram muncul di daftar metadata');
    const row = listed.secrets.find((s) => s.name === 'OPENAI_KEY');
    assert.ok(row, 'secret harus terlihat di daftar metadata');

    // nilai baru terdaftar di redactor SHARED → string mentah ter-redaksi
    assert.ok(!String(manager.redactor(`header: Bearer ${SEKRET}`)).includes(SEKRET));
  });

  test('20. POST /secrets/:name menolak nama non-identifier (400)', async () => {
    for (const bad of ['1BAD_NAME', 'BAD-DASH', 'bad dash', `A${'B'.repeat(64)}`]) {
      await assert.rejects(
        () => client.request('POST', `/secrets/${encodeURIComponent(bad)}`, { body: { value: SEKRET } }),
        (e) => e?.code === 'VALIDATION',
        `nama '${bad}' harus VALIDATION`,
      );
    }
  });

  test('21. POST /secrets/:name menolak nilai kosong dan >4096 byte (400)', async () => {
    await assert.rejects(
      () => client.request('POST', '/secrets/EMPTY_VAL', { body: { value: '' } }),
      (e) => e?.code === 'VALIDATION',
    );
    await assert.rejects(
      () => client.request('POST', '/secrets/NO_VALUE', { body: {} }),
      (e) => e?.code === 'VALIDATION',
    );
    await assert.rejects(
      () => client.request('POST', '/secrets/BIG_VAL', { body: { value: 'A'.repeat(4097) } }),
      (e) => e?.code === 'VALIDATION',
    );
    // tepat 4096 byte masih diterima
    const ok = await client.request('POST', '/secrets/EDGE_4096', {
      body: { value: 'A'.repeat(4096) },
    });
    assert.equal(ok.name, 'EDGE_4096');
  });

  test('22. rotate: POST upsert + PUT pada nama yang ada → tetap 1 entri, tanpa nilai', async () => {
    const before = (await client.request('GET', '/secrets')).secrets.filter(
      (s) => s.name === 'OPENAI_KEY',
    );
    assert.equal(before.length, 1);

    const upsert = await client.request('POST', '/secrets/OPENAI_KEY', {
      body: { value: `${SEKRET}-v2` },
    });
    assert.equal(upsert.name, 'OPENAI_KEY');

    const rotated = await client.request('PUT', '/secrets/OPENAI_KEY', {
      body: { value: `${SEKRET}-v3` },
    });
    assert.equal(rotated.name, 'OPENAI_KEY');
    assert.equal(typeof rotated.updatedAt, 'string');
    assert.ok(!JSON.stringify(rotated).includes(SEKRET));

    const after = (await client.request('GET', '/secrets')).secrets.filter(
      (s) => s.name === 'OPENAI_KEY',
    );
    assert.equal(after.length, 1, 'upsert/rotate tidak boleh membuat entri ganda');
  });

  test('23. PUT pada nama tak dikenal → 404; POST pada nama sama = create', async () => {
    await assert.rejects(
      () => client.request('PUT', '/secrets/NEVER_CREATED', { body: { value: SEKRET } }),
      (e) => e?.code === 'NOT_FOUND',
      'rotate nama asing harus NOT_FOUND (404)',
    );
    const created = await client.request('POST', '/secrets/NEVER_CREATED', {
      body: { value: SEKRET, projectScope: PID },
    });
    assert.equal(created.name, 'NEVER_CREATED');
    assert.equal(created.projectScope, PID);
    // scope berbeda tetap dianggap belum ada → PUT 404
    await assert.rejects(
      () => client.request('PUT', '/secrets/NEVER_CREATED', { body: { value: SEKRET } }),
      (e) => e?.code === 'NOT_FOUND',
      'PUT global pada secret ber-scope proyek harus NOT_FOUND',
    );
    await assert.rejects(
      () => client.request('POST', '/secrets/BAD_SCOPE', { body: { value: 'v', projectScope: 'a b/c' } }),
      (e) => e?.code === 'VALIDATION',
    );
  });

  test('24. hapus dua-fase: token salah → 403, token benar → removed', async () => {
    const req1 = await client.request('POST', '/secrets/NEVER_CREATED/remove-request', {
      body: { projectScope: PID },
    });
    assert.ok(req1.confirmToken, 'fase 1 wajib mengembalikan confirmToken');
    assert.equal(req1.name, 'NEVER_CREATED');

    await assert.rejects(
      () =>
        client.request('POST', '/secrets/NEVER_CREATED/remove', {
          body: { confirmToken: 'token-palsu-sekali', projectScope: PID },
        }),
      (e) => e?.code === 'PERMISSION_DENIED',
      'token salah harus PERMISSION_DENIED (403)',
    );
    await assert.rejects(
      () => client.request('POST', '/secrets/NEVER_CREATED/remove', { body: { projectScope: PID } }),
      (e) => e?.code === 'PERMISSION_DENIED',
      'tanpa confirmToken wajib ditolak',
    );

    const done = await client.request('POST', '/secrets/NEVER_CREATED/remove', {
      body: { confirmToken: req1.confirmToken, projectScope: PID },
    });
    assert.equal(done.removed, true);
    const listed = await client.request('GET', '/secrets');
    assert.equal(
      listed.secrets.filter((s) => s.name === 'NEVER_CREATED').length,
      0,
      'secret terhapus masih muncul di daftar',
    );
  });

  test('25. role viewer → 403 pada secret.manage (owner-only)', async () => {
    const pm = manager.permissionManager;
    assert.ok(pm, 'permissionManager aktif');
    const viewer = pm.createUser({ username: 'viewer-l5b', role: 'viewer', status: 'active' });
    const savedActor = manager.systemUserId;
    try {
      manager.systemUserId = viewer.userId;
      await assert.rejects(
        () => client.request('POST', '/secrets/FORBIDDEN_FOR_VIEWER', { body: { value: SEKRET } }),
        (e) => e?.code === 'PERMISSION_DENIED',
        'viewer haram menulis secret',
      );
    } finally {
      manager.systemUserId = savedActor;
    }
    const ok = await client.request('POST', '/secrets/BACK_TO_OWNER', { body: { value: SEKRET } });
    assert.equal(ok.name, 'BACK_TO_OWNER');
  });
});

// ── Gate-3 R2: preload nilai vault ke redactor SHARED saat boot ─────────────
describe('R2: vault preload redactor lintas-boot', () => {
  let rootDir2;
  const KUNCI = 'kunci-r2-uji-preload-42';
  const NILAI = 'RAHASIA-R2-bukti-preload-42';

  before(async () => {
    rootDir2 = mkdtempSync(join(tmpdir(), 'vmpanel-r2-'));
    for (const d of ['data', 'workspaces', 'runtime/pid', 'runtime/sockets', 'secrets']) {
      mkdirSync(join(rootDir2, d), { recursive: true });
    }
    process.env.VPANEL_MASTER_KEY = KUNCI;
    const portA = randomHighPort();
    const mA = new Manager({ rootDir: rootDir2, token: 't-r2', config: { manager: { apiPort: portA, hostMode: 'dev' } } });
    await mA.start();
    try {
      const cA = new ManagerClient({ port: portA, token: 't-r2' });
      await cA.request('POST', '/secrets/init', { body: {} });
      await cA.request('POST', '/secrets/R2_PRELOAD', { body: { value: NILAI, projectScope: null } });
    } finally {
      await mA.stop();
    }
  });

  after(() => {
    delete process.env.VPANEL_MASTER_KEY;
    if (rootDir2) rmSync(rootDir2, { recursive: true, force: true });
  });

  test('R2.1 boot kedua: nilai vault terdahulu ter-redaksi SEBELUM ada startService', async () => {
    const portB = randomHighPort();
    const mB = new Manager({ rootDir: rootDir2, token: 't-r2', config: { manager: { apiPort: portB, hostMode: 'dev' } } });
    await mB.start();
    try {
      assert.equal(mB.redactor.hasExtraValue(NILAI), true, 'preload mendaftarkan nilai ke redactor shared');
      assert.ok(!String(mB.redactor(`sampel ${NILAI} harus hilang`)).includes(NILAI), 'redaksi praktis menyembunyikan nilai');
    } finally {
      await mB.stop();
    }
  });

  test('R2.2 boot mencatat manager.secrets_preredacted tanpa pernah memuat nilai', async () => {
    const portC = randomHighPort();
    const mC = new Manager({ rootDir: rootDir2, token: 't-r2', config: { manager: { apiPort: portC, hostMode: 'dev' } } });
    await mC.start();
    try {
      const fsMod = await import('node:fs');
      const log = fsMod.readFileSync(join(rootDir2, 'logs', 'manager', 'manager.log'), 'utf8');
      assert.match(log, /manager\.secrets_preredacted/, 'event preload tercatat');
      assert.ok(!log.includes(NILAI), 'log tidak memuat nilai secret');
    } finally {
      await mC.stop();
    }
  });
});
