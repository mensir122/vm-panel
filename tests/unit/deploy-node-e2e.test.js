// tests/unit/deploy-node-e2e.test.js — E2E deploy node/python via Manager nyata
// di sandbox (pola projects-ui.test.js + deployment.test.js).
//
// Regresi BUG: service yang dibuat DeploymentManager saat deploy tidak membawa
// config.main → NodeAdapter.startSpec (cfg.main ?? this.pkg?.main) gagal
// VALIDATION 'node adapter requires main' → deployment failed@starting
// (adapter dibuat instance baru per stage sehingga this.pkg tidak persist).
//
// Skenario:
//  (1) node project + git repo LOKAL → deploy success (bukan failed@starting),
//      service running dengan config.main dari package.json, health ok,
//      HTTP GET / → 'ok'.
//  (2) deploy ulang setelah commit baru → revision baru, service TIDAK
//      diduplikasi (reuse + update config.rootDir), konten baru 'ok-v2'.
//  (3) python: startSpec menerima config.main (shape, tanpa exec python).
//  (4) python full deploy (skip bila python/git tidak ter-install di mesin).
//  (5) regresi: static adapter tetap jalan (workspace deploy + redeploy).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Manager } from '../../manager/index.js';
import { ManagerClient } from '../../lib/api-client.js';
import { PythonAdapter } from '../../manager/adapters/python-adapter.js';
import { VmPanelError, VALIDATION } from '../../lib/errors.js';

const execFileP = promisify(execFile);

function randomHighPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

/** Poll fetch sampai 200 (+ isi cocok bila expect diisi) atau timeout. */
async function waitForHttp(url, { timeoutMs = 10000, expect = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      const body = await res.text().catch(() => '');
      if (res.status === 200 && (expect === null || body === expect)) return body;
    } catch {
      /* belum listen — retry */
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout menunggu ${url}${expect ? ` (isi '${expect}')` : ''}`);
    }
    await delay(100);
  }
}

// --- availability guards (pola projects-ui.test.js) ---------------------------

let gitAvailable = false;
try {
  await execFileP(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { timeout: 10000 });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';
let pythonAvailable = false;
try {
  await execFileP(PYTHON_BIN, ['--version'], { timeout: 10000 });
  pythonAvailable = true;
} catch {
  pythonAvailable = false;
}

// --- fixture konten ------------------------------------------------------------
// server.js WAJIB pakai process.env.PORT (kontrak adapter: env {PORT}).

const SERVER_V1 =
  'const http=require("node:http");const p=+process.env.PORT||3000;' +
  'http.createServer((q,s)=>{s.end("ok")}).listen(p,"127.0.0.1");\n';
const SERVER_V2 =
  'const http=require("node:http");const p=+process.env.PORT||3000;' +
  'http.createServer((q,s)=>{s.end("ok-v2")}).listen(p,"127.0.0.1");\n';
const PY_MAIN = [
  'import os',
  'from http.server import BaseHTTPRequestHandler, HTTPServer',
  '',
  'class H(BaseHTTPRequestHandler):',
  '    def do_GET(self):',
  '        self.send_response(200)',
  '        self.end_headers()',
  '        self.wfile.write(b"py-ok")',
  '',
  'HTTPServer(("127.0.0.1", int(os.environ.get("PORT", "3000"))), H).serve_forever()',
  '',
].join('\n');
const LOCKFILE = JSON.stringify({
  name: 'e2e-node-app',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'e2e-node-app', version: '1.0.0' } },
});

/** git init + identitas + commit semua file di repoDir → return nama branch. */
async function gitInitCommit(repoDir, message) {
  const opts = { cwd: repoDir, timeout: 30000 };
  await execFileP('git', ['init'], opts);
  await execFileP('git', ['config', 'user.email', 'test@example.local'], opts);
  await execFileP('git', ['config', 'user.name', 'VM Panel Test'], opts);
  await execFileP('git', ['add', '.'], opts);
  await execFileP('git', ['commit', '-m', message], opts);
  const { stdout } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  return stdout.trim() || 'master';
}

// --- konteks -------------------------------------------------------------------

const ctx = {};

before(async () => {
  ctx.dir = mkdtempSync(join(tmpdir(), 'vmpanel-depnode-'));
  mkdirSync(join(ctx.dir, 'logs', 'projects'), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    ctx.manager = new Manager({
      rootDir: ctx.dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'depnode-manager-token-0123456789abcdef',
    });
    try {
      await ctx.manager.start();
      break;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  // Deploy (git clone + npm/venv) bisa lewat 10s default → timeout 120s.
  ctx.client = new ManagerClient({
    port: ctx.manager.api.port,
    token: ctx.manager.token,
    timeoutMs: 120_000,
  });

  // Repo git LOKAL (node): package.json {main:'server.js'} + server.js.
  ctx.nodeRepo = join(ctx.dir, 'fixture-node-repo');
  mkdirSync(ctx.nodeRepo, { recursive: true });
  writeFileSync(
    join(ctx.nodeRepo, 'package.json'),
    `${JSON.stringify({ name: 'e2e-node-app', version: '1.0.0', main: 'server.js' })}\n`,
  );
  writeFileSync(join(ctx.nodeRepo, 'package-lock.json'), `${LOCKFILE}\n`);
  writeFileSync(join(ctx.nodeRepo, 'server.js'), SERVER_V1);
  if (gitAvailable) ctx.nodeBranch = await gitInitCommit(ctx.nodeRepo, 'fixture v1');

  // Repo git LOKAL (python): main.py stdlib http server (PORT env).
  ctx.pyRepo = join(ctx.dir, 'fixture-python-repo');
  mkdirSync(ctx.pyRepo, { recursive: true });
  writeFileSync(join(ctx.pyRepo, 'main.py'), PY_MAIN);
  if (gitAvailable) ctx.pyBranch = await gitInitCommit(ctx.pyRepo, 'fixture py');
});

after(async () => {
  // Stop semua service dulu: child proses (node/python/static-server) menjaga
  // event loop tetap hidup dan cwd di sandbox (pola deployment.test.js).
  const sm = ctx.manager?.serviceManager;
  if (sm) {
    for (const s of sm.listServices()) {
      try { await sm.stopService(s.id); } catch { /* noop */ }
    }
  }
  if (ctx.manager?.running) await ctx.manager.stop();
  // Windows: handle sandbox bisa tertahan sesaat → rmSync retry best-effort.
  await delay(500);
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(ctx.dir, { recursive: true, force: true });
      break;
    } catch {
      await delay(300);
    }
  }
});

/** Port bebas 20000-29999 (legal range ProcessManager). */
async function pickFreePort() {
  for (let i = 0; i < 50; i++) {
    const port = randomHighPort();
    // eslint-disable-next-line no-await-in-loop
    if (await ctx.manager.processManager.portBindTest(port)) return port;
  }
  throw new Error('tidak ada port bebas ditemukan');
}

describe('deploy-node-e2e (deploy node/python via Manager nyata)', () => {
  test('(1) node + git lokal: deploy success, service running dengan config.main, health ok, HTTP ok', { skip: !gitAvailable }, async () => {
    const port = await pickFreePort();
    const project = await ctx.client.request('POST', '/projects', {
      body: {
        name: 'e2e-node-app',
        type: 'node',
        port: String(port),
        repo_url: ctx.nodeRepo,
        git_branch: ctx.nodeBranch,
      },
    });
    assert.ok(project.id.startsWith('prj_'));
    ctx.nodeProjectId = project.id;

    const dep = await ctx.client.request('POST', `/projects/${project.id}/deploy`, {
      body: { source: { type: 'git' } },
    });
    assert.equal(dep.status, 'success', `deploy harus success, bukan failed@starting (dep=${JSON.stringify(dep)})`);
    assert.ok(dep.deploymentId.startsWith('dep_'));
    assert.ok(!String(dep.revision).startsWith('ws-'), 'revision dari git rev-parse');
    ctx.firstRevision = dep.revision;

    // Service dibuat otomatis + config.main dari package.json workspace clone.
    const services = await ctx.client.request('GET', '/services');
    const svc = services.rows.find((s) => s.projectId === project.id);
    assert.ok(svc, 'service project node ada');
    assert.equal(svc.status, 'running');
    assert.equal(svc.config.main, 'server.js', 'config.main di-copy dari package.json');
    assert.equal(svc.config.type, 'node');
    assert.notEqual(svc.config.rootDir, project.workspacePath, 'rootDir = dir git clone');
    ctx.firstRootDir = svc.config.rootDir;

    // Health via API service (adapter default TCP health check).
    const health = await ctx.client.request('GET', `/services/${svc.id}/health`);
    assert.equal(health.ok, true, `health ok (got: ${JSON.stringify(health)})`);

    // HTTP nyata: server.js pakai PORT env → jawab 'ok'.
    const body = await waitForHttp(`http://127.0.0.1:${port}/`, { expect: 'ok' });
    assert.equal(body, 'ok');
  });

  test('(2) deploy ulang commit baru: revision baru, service reuse (tanpa duplikat), konten baru', { skip: !gitAvailable }, async () => {
    writeFileSync(join(ctx.nodeRepo, 'server.js'), SERVER_V2);
    const opts = { cwd: ctx.nodeRepo, timeout: 30000 };
    await execFileP('git', ['add', 'server.js'], opts);
    await execFileP('git', ['commit', '-m', 'v2'], opts);

    const dep2 = await ctx.client.request('POST', `/projects/${ctx.nodeProjectId}/deploy`, {
      body: { source: { type: 'git' } },
    });
    assert.equal(dep2.status, 'success');
    assert.notEqual(dep2.revision, ctx.firstRevision, 'revision baru untuk commit baru');

    // TIDAK diduplikasi: tetap satu service per project (config.rootDir di-update).
    const services = await ctx.client.request('GET', '/services');
    const mine = services.rows.filter((s) => s.projectId === ctx.nodeProjectId);
    assert.equal(mine.length, 1, 'service tidak diduplikasi saat re-deploy');
    assert.equal(mine[0].status, 'running');
    assert.notEqual(mine[0].config.rootDir, ctx.firstRootDir, 'rootDir clone baru');
    assert.equal(mine[0].config.main, 'server.js');

    const body = await waitForHttp(`http://127.0.0.1:${mine[0].port}/`, { expect: 'ok-v2' });
    assert.equal(body, 'ok-v2', 'konten baru terlihat setelah restart');
  });

  test('(3) python: startSpec menerima config.main (shape, tanpa exec)', () => {
    const ws = join(ctx.dir, 'py-shape-ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'main.py'), PY_MAIN);
    const port = 25432; // dummy — startSpec hanya menyusun argv, tidak exec

    const spec = new PythonAdapter({ workspacePath: ws, config: { main: 'main.py' } })
      .startSpec({ workspacePath: ws, config: { main: 'main.py' }, port });
    assert.equal(spec.cwd, ws);
    assert.equal(spec.env.PORT, String(port), 'PORT env dari port service');
    const venvPy = process.platform === 'win32'
      ? join(ws, '.venv', 'Scripts', 'python.exe')
      : join(ws, '.venv', 'bin', 'python');
    assert.equal(spec.argv[0], venvPy, 'argv[0] interpreter venv');
    assert.equal(spec.argv[1], join(ws, 'main.py'), 'argv[1] dari config.main');

    // Tanpa config.main → VALIDATION (main python wajib eksplisit).
    assert.throws(
      () => new PythonAdapter({ workspacePath: ws }).startSpec({ workspacePath: ws, port }),
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
    );
  });

  test('(4) python full deploy via git: success + config.main + health + HTTP py-ok', { skip: !pythonAvailable || !gitAvailable }, async () => {
    const port = await pickFreePort();
    const project = await ctx.client.request('POST', '/projects', {
      body: {
        name: 'e2e-python-app',
        type: 'python',
        port: String(port),
        repo_url: ctx.pyRepo,
        git_branch: ctx.pyBranch,
      },
    });

    const dep = await ctx.client.request('POST', `/projects/${project.id}/deploy`, {
      body: { source: { type: 'git' } },
    });
    assert.equal(dep.status, 'success', `deploy python success (dep=${JSON.stringify(dep)})`);

    const services = await ctx.client.request('GET', '/services');
    const svc = services.rows.find((s) => s.projectId === project.id);
    assert.ok(svc, 'service project python ada');
    assert.equal(svc.status, 'running');
    assert.equal(svc.config.main, 'main.py', 'config.main dibawa ke service');

    const health = await ctx.client.request('GET', `/services/${svc.id}/health`);
    assert.equal(health.ok, true, `health ok (got: ${JSON.stringify(health)})`);

    const body = await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 15000, expect: 'py-ok' });
    assert.equal(body, 'py-ok');
  });

  test('(5) regresi static: workspace deploy + redeploy tetap jalan, satu service', async () => {
    const port = await pickFreePort();
    const project = await ctx.client.request('POST', '/projects', {
      body: { name: 'e2e-static-app', type: 'static', port: String(port) },
    });
    writeFileSync(
      join(project.workspacePath, 'index.html'),
      '<!doctype html><body>e2e-static-ok</body></html>\n',
    );

    const dep = await ctx.client.request('POST', `/projects/${project.id}/deploy`, { body: {} });
    assert.equal(dep.status, 'success');

    const services = await ctx.client.request('GET', '/services');
    const mine = services.rows.filter((s) => s.projectId === project.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'running');
    const health = await ctx.client.request('GET', `/services/${mine[0].id}/health`);
    assert.equal(health.ok, true);
    const body = await waitForHttp(`http://127.0.0.1:${port}/`);
    assert.ok(body.includes('e2e-static-ok'));

    // Redeploy workspace → tetap success, service tetap satu + running.
    const dep2 = await ctx.client.request('POST', `/projects/${project.id}/deploy`, { body: {} });
    assert.equal(dep2.status, 'success');
    const services2 = await ctx.client.request('GET', '/services');
    const mine2 = services2.rows.filter((s) => s.projectId === project.id);
    assert.equal(mine2.length, 1, 'static redeploy tidak menduplikasi service');
    assert.equal(mine2[0].status, 'running');
  });
});
