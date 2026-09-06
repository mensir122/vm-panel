// tests/unit/projects-ui.test.js — E2E "kelola project 100% via UI web".
// Pola panel-e2e.test.js: Manager + Panel nyata di sandbox, bootstrap owner,
// login (password + TOTP), cookie manual + header X-CSRF-Token.
// Skenario: form New Project (owner-only), buat project dengan git URL LOKAL
// (repo git sungguhan dibuat offline via execFile git), deploy git source
// (git clone path lokal — offline-safe), deploy ulang idempoten, 403 non-owner,
// 403 tanpa CSRF, validasi repo_url invalid → alert tanpa crash.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Manager } from '../../manager/index.js';
import { PanelServer } from '../../panel/server/index.js';
import { ManagerClient } from '../../lib/api-client.js';
import { totpGenerate } from '../../lib/crypto.js';

const execFileP = promisify(execFile);

function randomHighPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

// --- fetch helpers dengan cookie manual (pola panel-e2e.test.js) --------------

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

// --- git availability guard (deploy-git test di-skip bila git tidak ada) ------

let gitAvailable = false;
try {
  await execFileP(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { timeout: 10000 });
  gitAvailable = true;
} catch {
  gitAvailable = false; // test deploy-git → skip; test workspace-mode tetap jalan
}

// --- konteks -------------------------------------------------------------------

const ctx = {};

before(async () => {
  ctx.dir = mkdtempSync(join(tmpdir(), 'vmpanel-prjui-'));
  mkdirSync(join(ctx.dir, 'logs', 'projects'), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    ctx.manager = new Manager({
      rootDir: ctx.dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'prjui-manager-token-0123456789abcdef',
    });
    try {
      await ctx.manager.start();
      break;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  ctx.panelData = mkdtempSync(join(tmpdir(), 'vmpanel-prjui-panel-'));
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

  // Repo git LOKAL sungguhan (offline): git init + package.json + index.html.
  ctx.gitRepo = join(ctx.dir, 'fixture-repo');
  mkdirSync(ctx.gitRepo, { recursive: true });
  writeFileSync(join(ctx.gitRepo, 'package.json'), '{"name":"prjui-fixture","version":"1.0.0","main":"index.js"}\n');
  writeFileSync(join(ctx.gitRepo, 'index.js'), 'const http=require("node:http");const p=+process.env.PORT||3000;http.createServer((q,s)=>{s.end("prjui-node-ok")}).listen(p);\n');
  writeFileSync(join(ctx.gitRepo, 'index.html'), '<!doctype html><body>prjui-static-ok</body></html>\n');
  if (gitAvailable) {
    const opts = { cwd: ctx.gitRepo, timeout: 30000 };
    // Commit per file — identitas git di sandbox CI/dev machine bisa kosong.
    await execFileP('git', ['init'], opts);
    await execFileP('git', ['config', 'user.email', 'test@example.local'], opts);
    await execFileP('git', ['config', 'user.name', 'VM Panel Test'], opts);
    await execFileP('git', ['add', 'package.json', 'index.js', 'index.html'], opts);
    await execFileP('git', ['commit', '-m', 'fixture'], opts);
    // Verify clone lokal jalan (pola sama dengan deploy git source).
    await execFileP('git', ['clone', '--depth', '1', '--branch', 'master', ctx.gitRepo, `${ctx.gitRepo}-clonecheck`], { timeout: 30000 });
  }
});

after(async () => {
  if (ctx.panel) await ctx.panel.close();
  if (ctx.manager && ctx.manager.running) await ctx.manager.stop();
  // Windows: proses anak (git/static-server) bisa menahan handle sandbox
  // sesaat setelah stop → rmSync best-effort retry, gagal diabaikan (tmp OS
  // akan dibersihkan sistem). Jangan biarkan cleanup merusak hasil suite.
  await delay(500);
  for (const d of [ctx.dir, ctx.panelData]) {
    if (!d) continue;
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch {
        await delay(300);
      }
    }
  }
});

describe('projects-ui (kelola project via web)', () => {
  test('(setup) bootstrap owner + login → cookie session + csrf', async () => {
    const jar = new Map();
    const boot = await req(ctx.port, 'GET', '/bootstrap', { jar });
    assert.equal(boot.status, 200);
    const bootHtml = await boot.text();
    const token = String(bootHtml.match(/name="token" value="([0-9a-f]+)"/)?.[1] ?? '');
    assert.ok(token.length >= 32);
    const bootRes = await req(ctx.port, 'POST', '/bootstrap', {
      jar,
      body: form({ token, username: 'admin', password: 'ownerpass123', confirm: 'ownerpass123' }),
    });
    assert.equal(bootRes.status, 200);
    const secret = (await bootRes.text()).match(/id="bootstrap-totp"[^>]*>([A-Z2-7]+)</)?.[1];
    assert.ok(secret, 'TOTP secret owner');

    const login = await req(ctx.port, 'POST', '/login', {
      jar,
      body: form({ username: 'admin', password: 'ownerpass123', totp: totpGenerate(secret) }),
    });
    assert.equal(login.status, 302);
    assert.ok(jar.has('vpanel_session') && jar.has('vpanel_csrf'), 'cookie session+csrf');
    ctx.ownerJar = jar;
  });

  test('(1) owner → GET /projects 200 dengan form New Project', async () => {
    const res = await req(ctx.port, 'GET', '/projects', { jar: ctx.ownerJar });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('name="name"'), 'field Nama');
    assert.ok(text.includes('name="type"'), 'field Tipe');
    assert.ok(text.includes('name="port"'), 'field Port');
    assert.ok(text.includes('name="repo_url"'), 'field Git URL');
    assert.ok(text.includes('name="git_branch"'), 'field Branch');
    assert.ok(text.includes('name="_csrf"'), 'CSRF hidden input');
    // Perilaku baru: form tersembunyi sampai tombol "New project" diklik.
    assert.ok(text.includes('data-reveal="#new-project"'), 'tombol New project me-reveal form');
    assert.ok(text.includes('id="new-project" hidden'), 'form tersembunyi secara default');
    assert.ok(!text.includes('type="button" disabled'), 'tidak ada tombol placeholder disabled');
  });

  test('(1b) error submit → form TERBUKA (tidak hidden) + alert + nilai dipertahankan', async () => {
    const res = await req(ctx.port, 'POST', '/projects', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: form({ name: 'bad url', type: 'node', repo_url: 'https://contoh dengan spasi.git' }),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes('id="new-project" hidden'), 'form harus terbuka saat ada error submit');
    assert.ok(text.includes('alert'), 'ada alert error');
    assert.ok(text.includes('bad url'), 'nilai form dipertahankan');
  });

  test('(2) POST /projects (git URL lokal) → redirect detail + project tampil', async () => {
    if (!gitAvailable) return; // tanpa git: buat tanpa repo_url di bawah
    // Project node (create-only; start node butuh config.main — lihat catatan
    // blocker adapter) DAN project static git untuk deploy flow (3)/(4).
    for (const spec of [
      { name: 'ui-node-app', type: 'node' },
      { name: 'ui-git-site', type: 'static' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await req(ctx.port, 'POST', '/projects', {
        jar: ctx.ownerJar,
        headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
        body: form({
          name: spec.name,
          type: spec.type,
          port: String(randomHighPort()),
          repo_url: ctx.gitRepo,
          git_branch: 'master',
        }),
      });
      assert.equal(res.status, 302, `sukses → redirect (${spec.name})`);
      assert.match(res.headers.get('location') ?? '', /^\/projects\/prj_/, 'redirect ke detail project');
    }

    const list = await req(ctx.port, 'GET', '/projects', { jar: ctx.ownerJar });
    const text = await list.text();
    assert.ok(text.includes('ui-node-app'), 'project node tampil');
    assert.ok(text.includes('ui-git-site'), 'project static git tampil');
    // Identifikasi by NAME (urutan listProjects tidak dijamin).
    const idByName = (name) =>
      text.match(new RegExp(`href="/projects/(prj_[A-Za-z0-9]+)"[^>]*>${name}<`))?.[1] ?? null;
    ctx.projectId = idByName('ui-node-app');
    ctx.gitProjectId = idByName('ui-git-site');
    assert.ok(ctx.projectId && ctx.gitProjectId, 'link detail kedua project ada');
  });

  test('(3) POST /projects/:id/deploy (repo_url git lokal) → success + service running + health ok', { skip: !gitAvailable }, async () => {
    const res = await req(ctx.port, 'POST', `/projects/${ctx.gitProjectId}/deploy`, {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(res.status, 302, 'deploy sukses → redirect detail');

    // Service dibuat otomatis oleh deploy dan running.
    const services = await ctx.managerClient.request('GET', '/services');
    assert.ok(Array.isArray(services.rows) && services.rows.length >= 1);
    const svc = services.rows.find((s) => s.projectId === ctx.gitProjectId);
    assert.ok(svc, 'service project ada');
    assert.equal(svc.status, 'running', 'service running');

    // Health ok (adapter static: HTTP GET / → 200 dari git clone target).
    const health = await ctx.managerClient.request('GET', `/services/${svc.id}/health`);
    assert.equal(health.ok, true, 'health check ok');

    // Deployment tercatat success dengan revision git (bukan ws-).
    const deps = await ctx.managerClient.request('GET', '/deployments', { query: { projectId: ctx.gitProjectId } });
    const dep = (deps.rows ?? []).find((d) => d.project_id === ctx.gitProjectId);
    assert.ok(dep, 'deployment tercatat');
    assert.equal(dep.status, 'success');
    assert.ok(!String(dep.revision ?? '').startsWith('ws-'), 'revision dari git rev-parse');
  });

  test('(4) deploy ulang → success lagi (idempoten)', { skip: !gitAvailable }, async () => {
    const res = await req(ctx.port, 'POST', `/projects/${ctx.gitProjectId}/deploy`, {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(res.status, 302);
    const deps = await ctx.managerClient.request('GET', '/deployments', { query: { projectId: ctx.gitProjectId } });
    const rows = (deps.rows ?? []).filter((d) => d.project_id === ctx.gitProjectId && d.status === 'success');
    assert.ok(rows.length >= 2, 'dua deployment success');
    const services = await ctx.managerClient.request('GET', '/services');
    const svc = services.rows.find((s) => s.projectId === ctx.gitProjectId);
    assert.equal(svc.status, 'running', 'service tetap running setelah redeploy');
  });

  test('(2b) mode workspace: project tanpa repo_url → deploy sukses', async () => {
    // Port bebas untuk service.
    let port = null;
    for (let i = 0; i < 100; i++) {
      const p = randomHighPort();
      // eslint-disable-next-line no-await-in-loop
      if (p !== ctx.manager.api.port && (await ctx.manager.processManager.portBindTest(p))) {
        port = p;
        break;
      }
    }
    assert.ok(port, 'port bebas');
    const res = await req(ctx.port, 'POST', '/projects', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: form({ name: 'ui-static-app', type: 'static', port: String(port) }),
    });
    assert.equal(res.status, 302);
    const list = await req(ctx.port, 'GET', '/projects', { jar: ctx.ownerJar });
    const ids = [...(await list.text()).matchAll(/href="\/projects\/(prj_[A-Za-z0-9]+)"/g)].map((m) => m[1]);
    ctx.wsProjectId = ids.find((id) => id !== ctx.projectId);
    assert.ok(ctx.wsProjectId, 'project workspace ada');

    // Fixture index.html di workspace (pola panel-e2e.test.js).
    const ws = join(ctx.dir, 'workspaces', ctx.wsProjectId);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'index.html'), '<!doctype html><body>prjui-ws</body></html>\n');

    const dep = await req(ctx.port, 'POST', `/projects/${ctx.wsProjectId}/deploy`, {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(dep.status, 302, 'deploy workspace sukses');
    const services = await ctx.managerClient.request('GET', '/services');
    const svc = services.rows.find((s) => s.projectId === ctx.wsProjectId);
    assert.ok(svc, 'service ada');
    assert.equal(svc.status, 'running');
  });

  test('(5) viewer → POST /projects → 403', async () => {
    // Owner buat user viewer + approve + set password (via PermissionManager/
    // PanelAuth API langsung — pola create-user di halaman /users).
    const perm = ctx.panel.auth.perm;
    const created = perm.createUser({ username: 'peeker', role: 'viewer' });
    perm.approveUser(created.userId, ctx.panel.auth.listUsers()[0].userId);
    ctx.panel.auth.setPassword('peeker', 'viewerpass123');

    const jarV = new Map();
    // 2FA wajib: viewer belum punya TOTP → pakai recovery code owner? Tidak —
    // viewer butuh faktor kedua sendiri. issueRecoveryCodes untuk viewer.
    const codes = ctx.panel.auth.issueRecoveryCodes('peeker');
    const login = await req(ctx.port, 'POST', '/login', {
      jar: jarV,
      body: form({ username: 'peeker', password: 'viewerpass123', recoveryCode: codes[0] }),
    });
    assert.equal(login.status, 302, 'viewer login sukses (recovery code)');

    const res = await req(ctx.port, 'POST', '/projects', {
      jar: jarV,
      headers: { 'x-csrf-token': jarV.get('vpanel_csrf') },
      body: form({ name: 'x-viewer-project', type: 'static' }),
    });
    assert.equal(res.status, 403, 'project.create ditolak untuk viewer');

    // Deploy juga ditolak untuk viewer (project.deploy = owner+operator).
    const dep = await req(ctx.port, 'POST', `/projects/${ctx.wsProjectId}/deploy`, {
      jar: jarV,
      headers: { 'x-csrf-token': jarV.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(dep.status, 403, 'project.deploy ditolak untuk viewer');
  });

  test('(6) POST tanpa CSRF → 403', async () => {
    const res = await req(ctx.port, 'POST', '/projects', {
      jar: ctx.ownerJar,
      body: form({ name: 'x-no-csrf', type: 'static' }),
    });
    assert.equal(res.status, 403);
    const res2 = await req(ctx.port, 'POST', `/projects/${ctx.wsProjectId}/deploy`, {
      jar: ctx.ownerJar,
      body: form({}),
    });
    assert.equal(res2.status, 403);
  });

  test('(7) repo_url invalid (spasi / ftp://) → alert VALIDATION, tidak crash', async () => {
    for (const bad of ['has space.git', 'ftp://example.com/x.git']) {
      const res = await req(ctx.port, 'POST', '/projects', {
        jar: ctx.ownerJar,
        headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
        body: form({ name: `bad-${Math.random().toString(36).slice(2, 8)}`, type: 'static', repo_url: bad }),
      });
      assert.equal(res.status, 400, `status 400 untuk repo_url "${bad}"`);
      const text = await res.text();
      assert.ok(text.includes('alert--error'), 'alert error tampil');
      assert.ok(text.includes('repo_url'), 'pesan validasi repo_url');
      assert.ok(!text.includes('name="name" value=""'), 'form diisi ulang (nilai dipertahankan)');
    }
  });

  test("(8) git_branch invalid ('..', '-x') → alert VALIDATION", async () => {
    for (const bad of ['../evil', '-oProxyCommand=x']) {
      const res = await req(ctx.port, 'POST', '/projects', {
        jar: ctx.ownerJar,
        headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
        body: form({ name: `br-${Math.random().toString(36).slice(2, 8)}`, type: 'static', git_branch: bad }),
      });
      assert.equal(res.status, 400, `status 400 untuk git_branch "${bad}"`);
      const text = await res.text();
      assert.ok(text.includes('alert--error'), 'alert error tampil');
    }
  });
});
