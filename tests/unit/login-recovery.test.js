// tests/unit/login-recovery.test.js — bug fix: kolom 2FA tunggal (name="totp")
// harus menerima TOTP ATAU recovery code. Sebelumnya recovery hanya dibaca dari
// field `recoveryCode` yang tidak pernah ada di form login → kode backup selalu
// ditolak walau valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PanelServer } from '../../panel/server/index.js';
import { PanelAuth } from '../../panel/server/auth.js';

async function withRig(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loginrec-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const auth = new PanelAuth({ dataDir });
  const boot = auth.bootstrapOwner({ username: 'admin', password: 'DummyPass-123' });
  const server = new PanelServer({
    rootDir: root,
    dataDir,
    config: { panel: { port: 0 }, manager: { apiPort: 59999 } },
    managerClient: { request: async () => { throw new Error('manager down'); } },
  });
  const addr = await server.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const form = (username, password, code) =>
    `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&totp=${encodeURIComponent(code)}`;
  try {
    await fn({ auth, boot, base, form });
  } finally {
    try { await server.close(); } catch { /* best-effort */ }
    auth.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* EPERM windows */ }
  }
}

test('login: recovery code DI KOLOM 2FA (name=totp) diterima', async () => {
  await withRig(async ({ boot, base, form }) => {
    const code = boot.recoveryCodes[0];
    const r = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form('admin', 'DummyPass-123', code),
      redirect: 'manual',
    });
    assert.equal(r.status, 302, 'recovery code valid harus login sukses (redirect)');
    assert.ok(String(r.headers.get('set-cookie') ?? '').includes('vpanel_session'));
  });
});

test('login: recovery code yang salah tetap ditolak', async () => {
  await withRig(async ({ base, form }) => {
    const r = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form('admin', 'DummyPass-123', 'bukan-kode-valid'),
    });
    assert.equal(r.status, 401);
  });
});

test('login: recovery code sekali pakai — kode kedua diperlukan', async () => {
  await withRig(async ({ boot, base, form }) => {
    const r1 = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form('admin', 'DummyPass-123', boot.recoveryCodes[0]),
      redirect: 'manual',
    });
    assert.equal(r1.status, 302);
    const r2 = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form('admin', 'DummyPass-123', boot.recoveryCodes[0]),
      redirect: 'manual',
    });
    assert.equal(r2.status, 401, 'kode yang sama tidak boleh terpakai dua kali');
  });
});
