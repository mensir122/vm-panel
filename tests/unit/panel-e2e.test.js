// tests/unit/panel-e2e.test.js — E2E F4 Wave 2 panel web (satu suite).
// Manager.start() nyata (port acak, token dummy) + PanelServer.start() nyata
// (ManagerClient menunjuk manager) → bootstrap owner via panel /bootstrap →
// login (password + TOTP) → aksi penuh: projects/deploy/services/backups/
// audit/logout → negative (redirect, CSRF 403) → manager stop → dashboard
// tetap 200 dengan banner (graceful). Fetch bawaan + cookie manual.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager } from '../../manager/index.js';
import { PanelServer } from '../../panel/server/index.js';
import { ManagerClient } from '../../lib/api-client.js';
import { totpGenerate } from '../../lib/crypto.js';

function randomHighPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

// --- fetch helpers dengan cookie manual --------------------------------------

function cookieJarFromResponse(res, jar) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of setCookies) {
    const m = String(line).match(/^\s*([^=;\s]+)=([^;]*)/);
    if (m) jar.set(m[1], m[2]);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(port, method, path, { jar, headers = {}, body = null, redirect = 'manual' } = {}) {
  const h = { ...headers };
  if (jar) h.cookie = jar.has('cookie') ? `${jar.get('cookie')}; ${cookieHeader(jar)}` : cookieHeader(jar);
  if (body !== null) h['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: h,
    body: body === null ? undefined : body,
    redirect,
  });
  if (jar) cookieJarFromResponse(res, jar);
  return res;
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

// --- konteks -------------------------------------------------------------------

const ctx = {};

before(async () => {
  // (a) sandbox tmp + Manager.start() port acak + token dummy
  ctx.dir = mkdtempSync(join(tmpdir(), 'vmpanel-e2e-'));
  mkdirSync(join(ctx.dir, 'logs', 'projects'), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    ctx.manager = new Manager({
      rootDir: ctx.dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'e2e-manager-token-0123456789abcdef',
    });
    try {
      await ctx.manager.start();
      break;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }

  // PanelServer nyata dengan ManagerClient menunjuk manager
  ctx.panelData = mkdtempSync(join(tmpdir(), 'vmpanel-e2e-panel-'));
  ctx.managerClient = new ManagerClient({ port: ctx.manager.api.port, token: ctx.manager.token });
  ctx.panel = new PanelServer({
    rootDir: ctx.dir,
    dataDir: ctx.panelData,
    config: { panel: { port: 0, ratePerMin: 1000, loginRatePerMin: 1000 }, manager: { apiPort: ctx.manager.api.port } },
    managerClient: ctx.managerClient,
    auditManager: ctx.manager.auditManager,
  });
  await ctx.panel.start();
  ctx.port = ctx.panel.port;
});

after(async () => {
  if (ctx.panel) await ctx.panel.close();
  if (ctx.manager && ctx.manager.running) await ctx.manager.stop();
  if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
  if (ctx.panelData) rmSync(ctx.panelData, { recursive: true, force: true });
});

describe('panel-e2e (F4 Wave 2)', () => {
  test('(a) GET /bootstrap saat belum ada owner → 200 form + token', async () => {
    const jar = new Map();
    const res = await req(ctx.port, 'GET', '/bootstrap', { jar });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('VPANEL'), 'halaman bootstrap memuat VPANEL');
    assert.ok(text.includes('name="token"'), 'form membawa token sekali-pakai');
    assert.ok(text.includes('name="password"'), 'form password');
    ctx.bootstrapHtml = text;
  });

  test('(a) POST /bootstrap → owner aktif + TOTP secret & recovery codes tampil sekali', async () => {
    const token = String(ctx.bootstrapHtml.match(/name="token" value="([0-9a-f]+)"/)?.[1] ?? '');
    assert.ok(token.length >= 32, 'token bootstrap ada');
    const res = await req(ctx.port, 'POST', '/bootstrap', {
      body: form({ token, username: 'admin', password: 'ownerpass123', confirm: 'ownerpass123' }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const secret = text.match(/id="bootstrap-totp"[^>]*>([A-Z2-7]+)</)?.[1];
    assert.ok(secret && secret.length >= 32, 'TOTP secret base32 tampil di halaman');
    const codes = [...text.matchAll(/<li><code class="mono">([0-9a-f]{8})<\/code><\/li>/g)].map((m) => m[1]);
    assert.equal(codes.length, 10, '10 recovery codes tampil');
    // owner aktif di users.db
    const users = ctx.panel.auth.listUsers();
    assert.equal(users[0]?.username, 'admin');
    assert.equal(users[0]?.role, 'owner');
    assert.equal(users[0]?.status, 'active');
    ctx.totpSecret = secret;

    // token sekali-pakai: pakai ulang token sama → ditolak
    const reuse = await req(ctx.port, 'POST', '/bootstrap', {
      body: form({ token, username: 'admin', password: 'ownerpass123', confirm: 'ownerpass123' }),
    });
    assert.equal(reuse.status, 403, 'owner sudah ada → PERMISSION_DENIED');
  });

  test('(a) GET /bootstrap setelah owner ada → redirect /login', async () => {
    const res = await req(ctx.port, 'GET', '/bootstrap', {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  });

  test('(d) GET / tanpa session → redirect /login', async () => {
    const res = await req(ctx.port, 'GET', '/', {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  });

  test('(b) login via POST /login (password + TOTP) → cookie session + csrf', async () => {
    const jar = new Map();
    const code = totpGenerate(ctx.totpSecret);
    const res = await req(ctx.port, 'POST', '/login', {
      jar,
      body: form({ username: 'admin', password: 'ownerpass123', totp: code }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    assert.ok(jar.has('vpanel_session'), 'session cookie');
    assert.ok(jar.has('vpanel_csrf'), 'csrf cookie');
    ctx.jar = jar;
  });

  test('(c) GET / dashboard 200 dan berisi VPANEL', async () => {
    const res = await req(ctx.port, 'GET', '/', { jar: ctx.jar });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('VPANEL'), 'brand VPANEL');
    assert.ok(!text.includes('Manager tidak terjangkau'), 'manager reachable → tanpa banner');
    assert.ok(text.includes('nav__link--active'), 'nav aktif ter-render');
  });

  test('(c) GET /projects 200', async () => {
    const res = await req(ctx.port, 'GET', '/projects', { jar: ctx.jar });
    assert.equal(res.status, 200);
    ctx.projectsHtmlBefore = await res.text();
  });

  let projectId;

  test('(c) POST /projects (CSRF header) → project muncul di GET /projects', async () => {
    const csrf = ctx.jar.get('vpanel_csrf');
    let port = null;
    for (let i = 0; i < 100; i++) {
      const p = randomHighPort();
      // eslint-disable-next-line no-await-in-loop
      if (p !== ctx.manager.api.port && (await ctx.manager.processManager.portBindTest(p))) {
        port = p;
        break;
      }
    }
    assert.ok(port, 'port bebas untuk service');
    ctx.svcPort = port;
    const res = await req(ctx.port, 'POST', '/projects', {
      jar: ctx.jar,
      headers: { 'x-csrf-token': csrf },
      body: form({ name: 'e2e-site', type: 'static', port: String(port) }),
    });
    assert.equal(res.status, 302, 'sukses → redirect ke /projects');

    const list = await req(ctx.port, 'GET', '/projects', { jar: ctx.jar });
    const text = await list.text();
    assert.ok(text.includes('e2e-site'), 'project baru tampil di tabel');
    projectId = text.match(/href="\/projects\/(prj_[A-Za-z0-9]+)"/)?.[1];
    assert.ok(projectId, 'link detail project ada');
  });

  test('(c) POST /projects/:id/deploy → sukses (static fixture workspace)', async () => {
    // fixture static di workspace project (workspacesRoot/<projectId>, ProjectManager)
    const ws = join(ctx.dir, 'workspaces', projectId);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'index.html'), '<!doctype html><body>panel-e2e</body></html>\n');

    const res = await req(ctx.port, 'POST', `/projects/${projectId}/deploy`, {
      jar: ctx.jar,
      headers: { 'x-csrf-token': ctx.jar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(res.status, 302);

    // service dibuat otomatis oleh deploy dan berstatus running
    const svcRes = await req(ctx.port, 'GET', '/services', { jar: ctx.jar });
    assert.equal(svcRes.status, 200);
    const svcText = await svcRes.text();
    ctx.servicesHtml = svcText;
    assert.ok(svcText.includes('running'), 'service running di tabel services');
  });

  test('(c) GET /services → service ada; POST /services/:id/stop → stopped', async () => {
    const mc = ctx.managerClient;
    const services = await mc.request('GET', '/services');
    assert.ok(Array.isArray(services.rows) && services.rows.length >= 1, 'service tercatat di manager');
    const svc = services.rows[0];
    assert.equal(svc.status, 'running');
    ctx.serviceId = svc.id;

    const res = await req(ctx.port, 'POST', `/services/${svc.id}/stop`, {
      jar: ctx.jar,
      headers: { 'x-csrf-token': ctx.jar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(res.status, 302);
    const after = await mc.request('GET', `/services/${svc.id}`);
    assert.equal(after.status, 'stopped');
  });

  test('(c) POST /backups → GET /backups berisi 1 baris valid', async () => {
    const res = await req(ctx.port, 'POST', '/backups', {
      jar: ctx.jar,
      headers: { 'x-csrf-token': ctx.jar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(res.status, 302);

    const list = await req(ctx.port, 'GET', '/backups', { jar: ctx.jar });
    assert.equal(list.status, 200);
    const text = await list.text();
    assert.ok(text.includes('bak_'), 'baris backup muncul');
    assert.ok(text.includes('valid'), 'badge verified valid');
  });

  test('(c) GET /audit berisi event login', async () => {
    const res = await req(ctx.port, 'GET', '/audit', { jar: ctx.jar });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('LOGIN_SUCCESS'), 'event login ter-audit via manager');
    assert.ok(text.includes('admin'), 'actor admin');
  });

  test('(c) POST /logout → session hilang', async () => {
    const res = await req(ctx.port, 'POST', '/logout', {
      jar: ctx.jar,
      headers: { 'x-csrf-token': ctx.jar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
    const after = await req(ctx.port, 'GET', '/', { jar: ctx.jar });
    assert.equal(after.status, 302, 'session sudah mati → redirect /login');
    assert.equal(after.headers.get('location'), '/login');
  });

  test('(d) POST aksi tanpa CSRF → 403', async () => {
    const jar2 = new Map();
    // session baru via recovery code (owner yang sama)
    const users = ctx.panel.auth.listUsers();
    assert.equal(users[0].username, 'admin');
    const res = await req(ctx.port, 'GET', '/', { jar: jar2 });
    assert.equal(res.status, 302); // belum login
    // login dulu (pakai secret bootstrap)
    const login = await req(ctx.port, 'POST', '/login', {
      jar: jar2,
      body: form({ username: 'admin', password: 'ownerpass123', totp: totpGenerate(ctx.totpSecret) }),
    });
    assert.equal(login.status, 302);
    // POST tanpa header x-csrf-token (hanya cookie) → ditolak 403
    const noCsrf = await req(ctx.port, 'POST', '/projects', {
      jar: jar2,
      body: form({ name: 'x-no-csrf', type: 'static' }),
    });
    assert.equal(noCsrf.status, 403);
    // CSRF cookie diset tapi header tidak cocok → 403 juga
    const badCsrf = await req(ctx.port, 'POST', '/projects', {
      jar: jar2,
      headers: { 'x-csrf-token': 'deadbeef' },
      body: form({ name: 'x-bad-csrf', type: 'static' }),
    });
    assert.equal(badCsrf.status, 403);
  });

  test('(e) manager di-stop → GET / tetap 200 dengan banner graceful', async () => {
    // login ulang (session lama sudah di-logout pada test logout)
    const login = await req(ctx.port, 'POST', '/login', {
      jar: ctx.jar,
      body: form({ username: 'admin', password: 'ownerpass123', totp: totpGenerate(ctx.totpSecret) }),
    });
    assert.equal(login.status, 302);
    await ctx.manager.stop();
    const res = await req(ctx.port, 'GET', '/', { jar: ctx.jar });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Manager tidak terjangkau'), 'banner manager down tampil');
    assert.ok(text.includes('VPANEL'), 'halaman tetap dirender penuh');
    assert.ok(text.includes('class="empty"'), 'empty state untuk data kosong');
  });
});
