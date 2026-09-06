// tests/unit/node-adapter-npm.test.js — mode npm-script (project Next.js-style):
// tanpa `main`, start via `npm run start`, build via `npm run build` saat install.
// Regresi: 9Router (github.com/decolua/9router) tidak punya package-lock.json,
// tidak punya main, scripts.start = "node custom-server.js --port 20127".
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Manager } from '../../manager/index.js';
import { NodeAdapter } from '../../manager/adapters/node-adapter.js';

const execFileP = promisify(execFile);

function randomHighPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

async function waitForHttp(url, { timeoutMs = 10000, expect = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      const body = await res.text().catch(() => '');
      if (res.status === 200 && (expect === null || body === expect)) return body;
    } catch {
      /* belum listen */
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout menunggu ${url}`);
    }
    await delay(100);
  }
}

// --- fixtures Next.js-style --------------------------------------------------

// package.json TANPA main, scripts.start = node custom.js, scripts.build ada.
const PKG_NO_MAIN = JSON.stringify({
  name: 'next-style-app',
  scripts: { start: 'node custom.js', build: 'node build.js' },
});

// custom.js WAJIB pakai process.env.PORT (kontrak adapter: env {PORT}).
const CUSTOM_JS =
  'const http=require("node:http");const fs=require("node:fs");' +
  'const stamp=fs.existsSync(".next-stamp")?fs.readFileSync(".next-stamp","utf8"):"no-build";' +
  'const p=+process.env.PORT||3000;' +
  'http.createServer((q,s)=>{s.end("ok-"+stamp)}).listen(p,"127.0.0.1");\n';
const BUILD_JS =
  'require("node:fs").writeFileSync(".next-stamp","built");\n';

let gitAvailable = false;
try {
  await execFileP(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { timeout: 10000 });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

function makeNextFixture(rootDir, name) {
  const ws = join(rootDir, name);
  fs.mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'package.json'), PKG_NO_MAIN);
  writeFileSync(join(ws, 'custom.js'), CUSTOM_JS);
  writeFileSync(join(ws, 'build.js'), BUILD_JS);
  return ws;
}

// --- unit: startSpec npm-script mode ------------------------------------------

describe('NodeAdapter npm-script mode (tanpa main)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'node-npm-'));
  });

  after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* EPERM windows */ }
  });

  test('startSpec: tanpa main + scripts.start → argv npm run start + env PORT', () => {
    const ws = makeNextFixture(dir, 'spec');
    const ad = new NodeAdapter({ workspacePath: ws });
    ad.validate({ workspacePath: ws });
    const spec = ad.startSpec({ workspacePath: ws, config: { port: 20127 }, port: 20127 });
    // Kontrak npmRunArgv: POSIX = ['npm','run','start']; Windows = node.exe +
    // npm-cli.js (tanpa shell, tanpa ketergantungan PATH) lalu ['run','start'].
    if (process.platform === 'win32') {
      assert.equal(spec.argv[0], process.execPath);
      assert.match(spec.argv[1] ?? '', /npm-cli\.js$/);
      assert.deepEqual(spec.argv.slice(2), ['run', 'start']);
    } else {
      assert.equal(spec.argv[0], 'npm');
      assert.deepEqual(spec.argv.slice(1), ['run', 'start']);
    }
    assert.equal(spec.cwd, ws);
    assert.equal(spec.env.PORT, '20127');
    assert.equal(spec.env.NEXT_TELEMETRY_DISABLED, '1');
    assert.equal(spec.port, 20127);
  });

  test('startSpec: dengan main → jalur klasik node <main> (regresi)', () => {
    const ws = join(dir, 'classic');
    fs.mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'x', main: 'server.js' }));
    writeFileSync(join(ws, 'server.js'), 'console.log("x");');
    const ad = new NodeAdapter({ workspacePath: ws });
    ad.validate({ workspacePath: ws });
    const spec = ad.startSpec({ workspacePath: ws, config: { port: 21001 }, port: 21001 });
    assert.equal(spec.argv[0], process.execPath);
    assert.match(spec.argv[1] ?? '', /server\.js$/);
  });

  test('validate: tanpa main DAN tanpa scripts.start → VALIDATION', () => {
    const ws = join(dir, 'bare');
    fs.mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'x' }));
    const ad = new NodeAdapter({ workspacePath: ws });
    assert.throws(() => ad.validate({ workspacePath: ws }), (e) => e.code === 'VALIDATION');
  });
});

// --- E2E: deploy Next-style via Manager nyata ---------------------------------

describe('E2E deploy Next-style (npm run build + npm run start)', () => {
  let ctx;
  let skipped = false;

  before(async () => {
    if (!gitAvailable) { skipped = true; return; }
    const root = mkdtempSync(join(tmpdir(), 'npm-deploy-'));
    for (const d of ['data', 'workspaces', 'runtime/pid', 'runtime/locks']) {
      mkdirSync(join(root, d), { recursive: true });
    }

    // git repo lokal (source git, offline-safe).
    const repoDir = join(root, 'seed-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), PKG_NO_MAIN);
    writeFileSync(join(repoDir, 'custom.js'), CUSTOM_JS);
    writeFileSync(join(repoDir, 'build.js'), BUILD_JS);
    const git = (args) => execFileP(
      process.platform === 'win32' ? 'git.exe' : 'git',
      args,
      { cwd: repoDir, timeout: 15000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } },
    );
    await git(['init', '--initial-branch=main']);
    await git(['add', '-A']);
    await git(['commit', '-m', 'v1']);

    ctx = { root, repoDir, port: randomHighPort() };
    ctx.manager = new Manager({ rootDir: root, token: 'npm-mode-token', config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } } });
    await ctx.manager.start();
    const info = ctx.manager.api;
    ctx.client = new ManagerClientCtor({ port: info.port, token: 'npm-mode-token' });
    ctx.base = `http://127.0.0.1:${info.port}`;
    ctx.stopped = [];
  });

  after(async () => {
    for (const s of ctx?.services ?? []) {
      try { await ctx.manager.serviceManager.stopService(s); } catch { /* best-effort */ }
    }
    try { await ctx?.manager?.stop(); } catch { /* best-effort */ }
    try { rmSync(ctx?.root, { recursive: true, force: true }); } catch { /* EPERM windows */ }
    await delay(250);
  });

  test('deploy → build stamp terbentuk sebelum start → service running → HTTP "ok-built"', async (t) => {
    if (skipped) return t.skip('git tidak tersedia');
    // (1) register project (type node, TANPA main — auto dari git).
    const create = await ctx.client.request('POST', '/projects', {
      body: { name: 'next-style', type: 'node', port: ctx.port, repo_url: ctx.repoDir, git_branch: 'main' },
    });
    assert.ok(create.id, 'project terdaftar');

    // (2) deploy sinkron (git source) — build harus sukses dulu.
    const dep = await ctx.client.request('POST', `/projects/${create.id}/deploy`, { body: { source: { type: 'git' } } });
    assert.equal(dep.status, 'success', `deploy harus success: ${JSON.stringify(dep).slice(0, 300)}`);

    // (3) build stamp terbentuk di workspace (bukti npm run build dijalankan).
    const ws = dep.manifest?.projectRoots?.[0] ?? null;
    void ws; // manifest tidak membawa workspace path — verifikasi via HTTP saja

    // (4) service running + HTTP mengembalikan hasil build.
    const services = await ctx.client.request('GET', '/services');
    const svc = services.rows.find((s) => s.projectId === create.id);
    assert.ok(svc, 'service ada');
    assert.equal(svc.status, 'running');
    ctx.services = [svc.id];
    const body = await waitForHttp(`http://127.0.0.1:${ctx.port}/`, { timeoutMs: 15000, expect: 'ok-built' });
    assert.equal(body, 'ok-built');
  });

  test('deploy ulang setelah commit baru → konten baru (re-deploy Next-style)', async (t) => {
    if (skipped) return t.skip('git tidak tersedia');
    const git = (args) => execFileP(
      process.platform === 'win32' ? 'git.exe' : 'git',
      args,
      { cwd: ctx.repoDir, timeout: 15000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } },
    );
    writeFileSync(join(ctx.repoDir, 'build.js'), BUILD_JS.replace('built', 'built-v2'));
    await git(['add', '-A']);
    await git(['commit', '-m', 'v2']);

    const dep = await ctx.client.request('POST', `/projects/${ctx.nextId ?? (await ctx.client.request('GET', '/projects')).find((p) => p.name === 'next-style').id}/deploy`, { body: { source: { type: 'git' } } });
    assert.equal(dep.status, 'success');
    const body = await waitForHttp(`http://127.0.0.1:${ctx.port}/`, { timeoutMs: 15000, expect: 'ok-built-v2' });
    assert.equal(body, 'ok-built-v2');
  });
});

// helper: ManagerClient dipakai via import dinamis agar file ini tidak duplikat
// import di atas (pola sama dengan deploy-node-e2e.test.js).
import { ManagerClient as ManagerClientCtor } from '../../lib/api-client.js';
