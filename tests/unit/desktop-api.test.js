// tests/unit/desktop-api.test.js — E2E test untuk endpoint /api/desktop/deploy-folder
// Mengikuti standar AGENTS.md: ESM, Node >= 20, sandbox terisolasi.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Manager } from '../../manager/index.js';
import { PanelServer } from '../../panel/server/index.js';
import { ManagerClient } from '../../lib/api-client.js';
import { totpGenerate } from '../../lib/crypto.js';

function randomHighPort() {
  return 22000 + Math.floor(Math.random() * 8000);
}

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

async function req(port, method, path, { jar, headers = {}, body = null } = {}) {
  const h = { ...headers };
  if (jar) h.cookie = cookieHeader(jar);
  if (body !== null && typeof body === 'object' && !h['content-type']) {
    h['content-type'] = 'application/json';
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: h,
    body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  if (jar) cookieJarFromResponse(res, jar);
  return res;
}

const ctx = {};

before(async () => {
  ctx.dir = mkdtempSync(join(tmpdir(), 'vmpanel-deskapi-'));
  mkdirSync(join(ctx.dir, 'logs', 'projects'), { recursive: true });

  ctx.manager = new Manager({
    rootDir: ctx.dir,
    config: { manager: { apiPort: randomHighPort(), hostMode: 'dev', rateLimitMax: 1000 } },
    token: 'deskapi-manager-token-0123456789abcdef',
  });
  await ctx.manager.start();

  ctx.panelData = mkdtempSync(join(tmpdir(), 'vmpanel-deskapi-panel-'));
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

  // Bootstrap owner
  const jar = new Map();
  const boot = await req(ctx.port, 'GET', '/bootstrap', { jar });
  const bootHtml = await boot.text();
  const token = String(bootHtml.match(/name="token" value="([0-9a-f]+)"/)?.[1] ?? '');

  const formParams = new URLSearchParams({ token, username: 'admin', password: 'password123', confirm: 'password123' }).toString();
  const bootRes = await req(ctx.port, 'POST', '/bootstrap', {
    jar,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formParams,
  });
  const secret = (await bootRes.text()).match(/id="bootstrap-totp"[^>]*>([A-Z2-7]+)</)?.[1];

  const loginParams = new URLSearchParams({ username: 'admin', password: 'password123', totp: totpGenerate(secret) }).toString();
  await req(ctx.port, 'POST', '/login', {
    jar,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: loginParams,
  });
  ctx.ownerJar = jar;
});

after(async () => {
  if (ctx.panel) await ctx.panel.close();
  if (ctx.manager && ctx.manager.running) {
    try {
      const svcs = ctx.manager.serviceManager?.listServices() ?? [];
      for (const s of svcs) {
        try { await ctx.manager.serviceManager.stopService(s.id); } catch {}
      }
    } catch {}
    await ctx.manager.stop();
  }
  await delay(400);
  for (const d of [ctx.dir, ctx.panelData]) {
    if (!d) continue;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe('POST /api/desktop/deploy-folder', () => {
  test('tanpa cookie/auth → ditolak', async () => {
    const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
      body: { folderPath: 'C:\\fake' },
    });
    assert.equal(res.status, 302); // Redirect to login
  });

  test('dengan auth tapi tanpa CSRF token → 403', async () => {
    const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
      jar: ctx.ownerJar,
      body: { folderPath: 'C:\\fake' },
    });
    assert.equal(res.status, 403);
  });

  test('dengan auth + CSRF tapi folderPath kosong → 400', async () => {
    const csrf = ctx.ownerJar.get('vpanel_csrf');
    const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': csrf },
      body: { folderPath: '' },
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /Path folder wajib diisi/);
  });

  test('deploy folder static web nyata → sukses 200 + project & service live', async () => {
    // Siapkan folder static lokal
    const siteDir = join(ctx.dir, 'sample-static-site');
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'index.html'), '<!doctype html><h1>Desktop Site Live</h1>');

    const csrf = ctx.ownerJar.get('vpanel_csrf');
    const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': csrf },
      body: { folderPath: siteDir },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.project);
    assert.equal(data.project.type, 'static');
    assert.ok(data.project.port >= 10001);
  });

  test('deploy folder dengan auto247 → sukses 200 + cloud247 terdaftar di manifest', async () => {
    const botDir = join(ctx.dir, 'sample-247-bot');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, 'index.html'), '<!doctype html><h1>24/7 Cloud Bot</h1>');

    const csrf = ctx.ownerJar.get('vpanel_csrf');
    const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': csrf },
      body: {
        folderPath: botDir,
        name: 'cloud-bot-test',
        auto247: true,
        repoUrl: 'https://github.com/myuser/cloud-bot-test',
      },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.cloud247);
    assert.equal(data.cloud247.enabled, true);

    // Verifikasi projects.auto.json di root panel
    const manifestFile = join(ctx.dir, 'projects.auto.json');
    assert.equal(existsSync(manifestFile), true);
    const list = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const found = list.find((p) => p.name === 'cloud-bot-test');
    assert.ok(found, 'Entri project harus terdaftar di projects.auto.json');
    assert.equal(found.repo_url, 'https://github.com/myuser/cloud-bot-test');
    assert.equal(found.enabled, true);
  });

  test('deploy folder dengan token pada repoUrl → token dibersihkan dari manifest (anti-leak)', async () => {
    const secretDir = join(ctx.dir, 'sample-secret-bot');
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, 'index.html'), '<!doctype html><h1>Secret Bot</h1>');

    const csrf = ctx.ownerJar.get('vpanel_csrf');
    const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': csrf },
      body: {
        folderPath: secretDir,
        name: 'secret-token-bot',
        auto247: true,
        repoUrl: 'https://ghp_leakedToken999@github.com/myuser/secret-repo.git',
      },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    // Verifikasi token TIDAK ada di projects.auto.json
    const manifestFile = join(ctx.dir, 'projects.auto.json');
    const list = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const found = list.find((p) => p.name === 'secret-token-bot');
    assert.ok(found);
    assert.equal(found.repo_url, 'https://github.com/myuser/secret-repo');
    assert.ok(!found.repo_url.includes('ghp_leakedToken999'));
  });
});

describe('POST /api/desktop/inspect-folder (A2#4 rute baru)', () => {
  test('tanpa CSRF → 403', async () => {
    const res = await req(ctx.port, 'POST', '/api/desktop/inspect-folder', {
      jar: ctx.ownerJar,
      body: { folderPath: ctx.dir },
    });
    assert.equal(res.status, 403);
    await res.text();
  });

  test('folder berisi package.json → 200 + inspection.framework + detectedEnvs', async () => {
    const nodeDir = join(ctx.dir, 'inspect-node-app');
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(
      join(nodeDir, 'package.json'),
      JSON.stringify({ name: 'inspect-me', main: 'index.js', dependencies: { express: '^4' } }),
    );
    writeFileSync(join(nodeDir, 'index.js'), "const p = process.env.API_TOKEN; console.log(p);");

    const res = await req(ctx.port, 'POST', '/api/desktop/inspect-folder', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: { folderPath: nodeDir },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.inspection.type, 'node');
    assert.ok(typeof data.inspection.framework === 'string' && data.inspection.framework !== '');
    assert.ok(Array.isArray(data.inspection.detectedEnvs));
    assert.ok(data.inspection.detectedEnvs.some((e) => e.key === 'API_TOKEN'), 'env token terdeteksi');
  });

  test('path tidak ada → 400 dengan pesan generik (tanpa internal)', async () => {
    const res = await req(ctx.port, 'POST', '/api/desktop/inspect-folder', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: { folderPath: join(ctx.dir, 'no-such-folder-a24') },
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.ok(!String(data.error).includes('no-such-folder-a24'), 'pesan tidak membocorkan path internal');
  });
});

describe('POST /api/desktop/deploy-folder — validasi port & error generik', () => {
  test('port reserved (8080/8097) → 400, project tidak dibuat (A2#24)', async () => {
    const siteDir = join(ctx.dir, 'port-guard-site');
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'index.html'), '<!doctype html><h1>x</h1>');
    for (const bad of [8080, 8097, 80, 99999, 'abc']) {
      const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
        jar: ctx.ownerJar,
        headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
        body: { folderPath: siteDir, port: bad },
      });
      assert.equal(res.status, 400, `port ${bad} harus ditolak`);
      const data = await res.json();
      assert.equal(data.ok, false);
    }
    const projects = ctx.manager.projectManager.listProjects();
    assert.ok(
      !projects.some((p) => [8080, 8097, 80, 99999].includes(p.port)),
      'project dengan port ilegal tidak pernah dibuat',
    );
  });

  test('error internal → response generik, e.message tidak bocor (A2#2)', async () => {
    const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: { folderPath: join(ctx.dir, 'definitely-missing-a22') },
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.ok(!String(data.error).includes('definitely-missing-a22'), 'path internal tidak bocor ke response');
  });
});

// REM1 — regresi bot pada semantik liveness baru. Deployment manager kini
// men-FAIL-kan service tcp/http yang tak pernah listening, jadi dropzone wajib
// menandai bot-like workload dengan healthCheck { type: 'process' } saat POST
// /projects, sementara web/API biasa tetap memakai default (tcp → tak dikirim).
describe('POST /api/desktop/deploy-folder — healthCheck bot (REM1)', () => {
  // Intercept HANYA POST /projects: catat body + kembalikan stub tanpa
  // workspacePath (copy dilewati) supaya tidak ada npm install/spawn proses
  // nyata. Semua request lain didelegasikan ke manager asli.
  function interceptProjectsCreate() {
    const client = ctx.managerClient;
    const orig = client.request.bind(client);
    const seen = { bodies: [], deployStatus: null };
    client.request = async (method, path, opts = {}) => {
      if (method === 'POST' && path === '/projects') {
        seen.bodies.push(opts.body);
        return { id: 'prj_rem1_stub', name: opts?.body?.name, type: opts?.body?.type, port: opts?.body?.port };
      }
      if (method === 'POST' && /^\/projects\/prj_rem1_stub\/deploy$/.test(path)) {
        try {
          await orig(method, path, opts);
          seen.deployStatus = 200;
        } catch (e) {
          seen.deployStatus = e?.details?.status ?? null;
        }
        return { ok: false };
      }
      return orig(method, path, opts);
    };
    return { seen, restore: () => { client.request = orig; } };
  }

  test('folder bot (telegraf) → body POST /projects memuat healthCheck.type=process', async () => {
    const botDir = join(ctx.dir, 'rem1-telegram-bot');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(
      join(botDir, 'package.json'),
      JSON.stringify({ name: 'rem1-telegram-bot', main: 'index.js', dependencies: { telegraf: '^4' } }),
    );
    writeFileSync(join(botDir, 'index.js'), "const { Telegraf } = require('telegraf'); console.log('bot');");

    const itc = interceptProjectsCreate();
    try {
      const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
        jar: ctx.ownerJar,
        headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
        body: { folderPath: botDir, name: 'rem1-telegram-bot' },
      });
      assert.equal(res.status, 200, 'deploy folder bot harus sukses');
      assert.equal(itc.seen.bodies.length, 1, 'tepat satu POST /projects');
      const body = itc.seen.bodies[0];
      assert.deepEqual(
        body.healthCheck,
        { type: 'process' },
        'bot wajib ditandai healthCheck process, bukan default tcp',
      );
      assert.ok(
        itc.seen.deployStatus !== 200 && itc.seen.deployStatus !== null,
        'deploy hanya disentuh untuk stub yang memang tak ada di manager (error expected)',
      );
    } finally {
      itc.restore();
    }
  });

  test('folder web biasa (express) → body POST /projects TANPA healthCheck (default tcp)', async () => {
    const webDir = join(ctx.dir, 'rem1-web-app');
    mkdirSync(webDir, { recursive: true });
    writeFileSync(
      join(webDir, 'package.json'),
      JSON.stringify({ name: 'rem1-web-app', main: 'server.js', dependencies: { express: '^4' } }),
    );
    writeFileSync(join(webDir, 'server.js'), "require('express')().listen(0);");

    const itc = interceptProjectsCreate();
    try {
      const res = await req(ctx.port, 'POST', '/api/desktop/deploy-folder', {
        jar: ctx.ownerJar,
        headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
        body: { folderPath: webDir, name: 'rem1-web-app' },
      });
      assert.equal(res.status, 200, 'deploy folder web harus sukses');
      assert.equal(itc.seen.bodies.length, 1, 'tepat satu POST /projects');
      const body = itc.seen.bodies[0];
      assert.equal(
        body.healthCheck,
        undefined,
        'web/API biasa tidak mengirim healthCheck → adapter default tcp',
      );
      assert.ok(!('healthCheck' in body), 'key healthCheck tidak boleh ada sama sekali');
    } finally {
      itc.restore();
    }
  });
});

