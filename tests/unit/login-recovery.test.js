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
import { openDatabase } from '../../lib/db.js';

async function withRig(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loginrec-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const auth = new PanelAuth({ dataDir });
  const boot = auth.bootstrapOwner({ username: 'admin', password: 'DummyPass-123' });
  auth.close(); // tutup — PanelServer buat PanelAuth sendiri
  const server = new PanelServer({
    rootDir: root,
    dataDir,
    config: { panel: { port: 0, localhostBypass2fa: false }, manager: { apiPort: 59999 } },
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

// --- A2#1: status user harus 'active' untuk login & sesi ----------------------

test('A2#1: user non-active ditolak login (pesan generik) dan sesi lamanya ikut mati', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loginactive-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const auth = new PanelAuth({ dataDir });
    auth.bootstrapOwner({ username: 'admin', password: 'DummyPass-123' });
    const perm = auth.perm;
    const owner = perm.getUserByUsername('admin');

    // buat + approve + password untuk user 'ina'
    const created = perm.createUser({ username: 'ina', role: 'operator' });
    perm.approveUser(created.userId, owner.userId);
    auth.setPassword('ina', 'PassIna-123');

    // 1. active → login sukses, sesi hidup
    const ok = auth.login({ username: 'ina', password: 'PassIna-123', ip: '127.0.0.1' });
    assert.equal(ok.ok, true, 'login saat active harus sukses');
    assert.ok(auth.getSession(ok.sessionId), 'sesi aktif terbaca');

    // 2. nonaktifkan user di DB (setelah sesi terbit)
    const h = openDatabase(path.join(dataDir, 'users.db'), { schemaName: 'users' });
    h.db.prepare("UPDATE users SET status = 'inactive' WHERE username = 'ina'").run();
    h.close();

    // 3. sesi lama → null (A2#1 getSession)
    assert.equal(auth.getSession(ok.sessionId), null, 'sesi user non-active harus mati');

    // 4. login ulang → invalid generik tanpa reveal status
    const denied = auth.login({ username: 'ina', password: 'PassIna-123', ip: '127.0.0.1' });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'invalid', 'reason generik "invalid" — bukan bocoran status');

    // 5. A2#29 guard: user tak dikenal pun tetap lewat jalur yang sama (tidak crash)
    const ghost = auth.login({ username: 'ghost-timing', password: 'whatever123', ip: '127.0.0.1' });
    assert.equal(ghost.reason, 'invalid');

    auth.close();
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* EPERM windows */ }
  }
});

// --- A2#20: pembersihan sesi kedaluwarsa saat start ---------------------------

test('A2#20: instans PanelAuth baru membersihkan baris sesi kedaluwarsa saat start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loginclean-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    let t = Date.parse('2026-01-01T00:00:00.000Z');
    const auth1 = new PanelAuth({ dataDir, sessionTtlMs: 1000, now: () => t });
    auth1.bootstrapOwner({ username: 'admin', password: 'DummyPass-123' });
    const ok = auth1.login({ username: 'admin', password: 'DummyPass-123', ip: '127.0.0.1' });
    assert.equal(ok.ok, true);
    // sesi tercatat dan masih hidup pada jam yang sama
    assert.ok(auth1.getSession(ok.sessionId));
    auth1.close();

    // majukan clock melewati TTL, buat instans baru → cleanupExpired saat konstruksi
    t += 5000;
    const auth2 = new PanelAuth({ dataDir, now: () => t });
    const h = openDatabase(path.join(dataDir, 'users.db'), { schemaName: 'users' });
    const { c } = h.db.prepare('SELECT COUNT(*) AS c FROM sessions').get();
    h.close();
    assert.equal(c, 0, 'baris sesi kedaluwarsa TERHAPUS saat start (bukan cuma di-null-kan saat baca)');
    assert.equal(auth2.getSession(ok.sessionId), null);
    auth2.close();
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* EPERM windows */ }
  }
});
