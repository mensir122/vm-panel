// tests/unit/adapters.test.js — unit + mini-E2E untuk manager/adapters (Fase F2).
import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { VmPanelError, VALIDATION, NOT_FOUND } from '../../lib/errors.js';
import { BaseAdapter } from '../../manager/adapters/base.js';
import { StaticAdapter } from '../../manager/adapters/static-adapter.js';
import { NodeAdapter } from '../../manager/adapters/node-adapter.js';
import { PythonAdapter } from '../../manager/adapters/python-adapter.js';
import { ADAPTERS, createAdapter } from '../../manager/adapters/index.js';

const STATIC_SERVER_JS = fileURLToPath(
  new URL('../../manager/adapters/static-server.js', import.meta.url),
);

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-adapters-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function assertVmPanelError(fn, code, msgIncludes) {
  try {
    fn();
    assert.fail('expected VmPanelError');
  } catch (e) {
    assert.ok(e instanceof VmPanelError, `bukan VmPanelError: ${e}`);
    assert.equal(e.code, code);
    if (msgIncludes) assert.ok(String(e.message).includes(msgIncludes), `message: ${e.message}`);
  }
}

function assertVmPanelErrorAsync(fn, code, msgIncludes) {
  return fn().then(
    () => assert.fail('expected VmPanelError'),
    (e) => {
      assert.ok(e instanceof VmPanelError, `bukan VmPanelError: ${e}`);
      assert.equal(e.code, code);
      if (msgIncludes) assert.ok(String(e.message).includes(msgIncludes), `message: ${e.message}`);
    },
  );
}

// ---------------------------------------------------------------- registry
describe('registry', () => {
  test('ADAPTERS memuat static/node/python', () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), ['node', 'python', 'static']);
  });

  test('createAdapter: valid → instance class yang benar', () => {
    assert.ok(createAdapter('static', { workspacePath: dir }) instanceof StaticAdapter);
    assert.ok(createAdapter('node', { workspacePath: dir }) instanceof NodeAdapter);
    assert.ok(createAdapter('python', { workspacePath: dir }) instanceof PythonAdapter);
  });

  test('createAdapter: type tak dikenal → VALIDATION', () => {
    assertVmPanelError(() => createAdapter('docker'), VALIDATION, 'tidak dikenal');
    assertVmPanelError(() => createAdapter(undefined), VALIDATION);
  });
});

// ---------------------------------------------------------------- base
describe('base adapter', () => {
  test('method tak di-overwrite → VALIDATION "not implemented"', () => {
    const base = new BaseAdapter({ name: 'base' });
    const methods = [
      'detect', 'validate', 'prepare', 'install', 'configure',
      'startSpec', 'stopSpec', 'healthCheckSpec', 'cleanup',
      'exportState', 'restoreState',
    ];
    for (const m of methods) {
      let threw = null;
      try {
        base[m]();
      } catch (e) {
        threw = e;
      }
      assert.ok(threw instanceof VmPanelError, `${m} tidak throw`);
      assert.equal(threw.code, VALIDATION, `${m} bukan VALIDATION`);
      assert.ok(threw.message.includes('not implemented'), `${m}: ${threw.message}`);
    }
  });

  test('assertWorkspace: ctx.workspacePath wajib ada → NOT_FOUND', () => {
    const base = new BaseAdapter({ name: 'base' });
    assertVmPanelError(() => base.assertWorkspace({}), NOT_FOUND);
    assertVmPanelError(() => base.assertWorkspace({ workspacePath: path.join(dir, 'nope') }), NOT_FOUND);
    assert.equal(base.assertWorkspace({ workspacePath: dir }), dir);
  });

  test('assertWorkspace: fallback ke constructor workspacePath', () => {
    const base = new BaseAdapter({ name: 'base', workspacePath: dir });
    assert.equal(base.assertWorkspace(), dir);
  });
});

// ---------------------------------------------------------------- static
describe('static adapter', () => {
  function makeStaticFixture(withIndex = true) {
    const ws = path.join(dir, `static-${withIndex ? 'ok' : 'empty'}`);
    fs.mkdirSync(ws, { recursive: true });
    if (withIndex) {
      fs.writeFileSync(path.join(ws, 'index.html'), '<h1>VM-Panel fixture</h1>');
    }
    return ws;
  }

  test('detect: true jika ada index.html, false jika tidak', () => {
    const ws = makeStaticFixture(true);
    assert.equal(new StaticAdapter().detect({ workspacePath: ws }), true);
    const empty = makeStaticFixture(false);
    assert.equal(new StaticAdapter().detect({ workspacePath: empty }), false);
  });

  test('validate ok dengan index.html + port', () => {
    const ws = makeStaticFixture(true);
    const ad = new StaticAdapter({ workspacePath: ws });
    const res = ad.validate({ port: 8123 });
    assert.equal(res.ok, true);
    assert.equal(res.port, 8123);
  });

  test('validate: tanpa index.html → VALIDATION "requires index.html"', () => {
    const empty = makeStaticFixture(false);
    assertVmPanelError(
      () => new StaticAdapter({ workspacePath: empty }).validate({ port: 8123 }),
      VALIDATION, 'index.html',
    );
  });

  test('validate: tanpa port → VALIDATION', () => {
    const ws = makeStaticFixture(true);
    assertVmPanelError(
      () => new StaticAdapter({ workspacePath: ws }).validate({}),
      VALIDATION, 'port',
    );
  });

  test('startSpec: argv shape benar + port benar', () => {
    const ws = makeStaticFixture(true);
    const ad = new StaticAdapter({ workspacePath: ws });
    const spec = ad.startSpec({ workspacePath: ws, config: { port: 8124 } });
    assert.equal(spec.argv[0], process.execPath);
    assert.equal(path.resolve(spec.argv[1]), path.resolve(STATIC_SERVER_JS));
    assert.deepEqual(spec.argv.slice(2), ['--root', ws, '--port', '8124', '--host', '127.0.0.1']);
    assert.equal(spec.port, 8124);
    assert.equal(spec.cwd, ws);
    assert.deepEqual(spec.env, {});
  });

  test('E2E kecil: static-server serve fixture, tolak traversal, lalu kill', async () => {
    const ws = makeStaticFixture(true);
    fs.writeFileSync(path.join(ws, 'style.css'), 'body { color: rebeccapurple; }');
    const ad = new StaticAdapter({ workspacePath: ws });
    const spec = ad.startSpec({ workspacePath: ws, config: { port: 8125 } });

    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: 'ignore' });
    try {
      // tunggu server listen (poll hingga 3s alih-alih sleep buta 500ms).
      let listened = false;
      for (let i = 0; i < 60 && !listened; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          const probe = await fetch('http://127.0.0.1:8125/');
          if (probe.status) listened = true;
        } catch { /* belum listen */ }
      }
      assert.ok(listened, 'static-server tidak listen');

      const res = await fetch('http://127.0.0.1:8125/');
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('VM-Panel fixture'), `body: ${body}`);

      const css = await fetch('http://127.0.0.1:8125/style.css');
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type') ?? '', /text\/css/);

      // traversal: '/../escape' harus tidak keluar root (404/400)
      const enc404 = await fetch('http://127.0.0.1:8125/%2e%2e/escape');
      assert.ok([400, 404].includes(enc404.status), `traversal status: ${enc404.status}`);
      // raw '/../...' di URL: fetch/undici mem-flatten '..', server resolve-nya
      // kembali ke style.css di dalam root → tetap 200; yang penting TIDAK 3xx/escape.
      const raw = await fetch('http://127.0.0.1:8125/esc/../style.css');
      assert.equal(raw.status, 200);
      assert.ok((await raw.text()).includes('rebeccapurple'));
      const missing = await fetch('http://127.0.0.1:8125/tidak-ada.html');
      assert.equal(missing.status, 404);
    } finally {
      child.kill('SIGKILL');
      // Tunggu child benar-benar exit agar Windows melepas handle cwd fixture
      // sebelum afterEach rmSync (EPERM jika masih held).
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        setTimeout(resolve, 3000).unref();
      });
    }
  });
});

// ---------------------------------------------------------------- node
describe('node adapter', () => {
  function makeNodeFixture({ main = 'server.js', corrupt = false, withStart = false } = {}) {
    const ws = path.join(dir, `node-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(ws, { recursive: true });
    if (corrupt) {
      fs.writeFileSync(path.join(ws, 'package.json'), '{ bukan json !!');
    } else {
      const pkg = {};
      if (main) pkg.main = main;
      if (withStart) pkg.scripts = { start: 'node server.js' };
      fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify(pkg));
    }
    if (main || withStart) {
      fs.writeFileSync(
        path.join(ws, main ?? 'server.js'),
        'process.stdout.write("node fixture ok")',
      );
    }
    return ws;
  }

  test('detect: true jika ada package.json', () => {
    const ws = makeNodeFixture();
    assert.equal(new NodeAdapter().detect({ workspacePath: ws }), true);
    assert.equal(new NodeAdapter().detect({ workspacePath: dir }), false);
  });

  test('validate ok: main ada; startSpec shape benar', () => {
    const ws = makeNodeFixture({ main: 'server.js' });
    const ad = new NodeAdapter({ workspacePath: ws });
    const v = ad.validate({});
    assert.equal(v.ok, true);
    assert.equal(v.main, 'server.js');
    const spec = ad.startSpec({ workspacePath: ws, config: { port: 8130 } });
    assert.equal(spec.argv[0], process.execPath);
    assert.equal(spec.argv[1], path.join(ws, 'server.js'));
    assert.equal(spec.cwd, ws);
    assert.deepEqual(spec.env, { PORT: '8130' });
    assert.equal(spec.port, 8130);
  });

  test('validate ok: tanpa main tapi ada scripts.start', () => {
    const ws = makeNodeFixture({ main: null, withStart: true });
    const v = new NodeAdapter({ workspacePath: ws }).validate({});
    assert.equal(v.ok, true);
    assert.equal(v.main, null);
    assert.equal(v.hasStart, true);
  });

  test('package.json korup → VALIDATION', () => {
    const ws = makeNodeFixture({ corrupt: true });
    assertVmPanelError(
      () => new NodeAdapter({ workspacePath: ws }).validate({}),
      VALIDATION, 'korup',
    );
  });

  test('tanpa main & tanpa scripts.start → VALIDATION', () => {
    const ws = path.join(dir, 'node-bare');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'x' }));
    assertVmPanelError(
      () => new NodeAdapter({ workspacePath: ws }).validate({}),
      VALIDATION, 'main',
    );
  });

  test('healthCheckSpec: config.healthCheck menang, default tcp', () => {
    const ws = makeNodeFixture();
    const ad = new NodeAdapter({ workspacePath: ws });
    assert.deepEqual(
      ad.healthCheckSpec({ config: { port: 8131 } }),
      { type: 'tcp', port: 8131 },
    );
    const hc = { type: 'http', url: 'http://127.0.0.1:8131/health', expectStatus: 200 };
    assert.deepEqual(ad.healthCheckSpec({ config: { port: 8131, healthCheck: hc } }), hc);
  });

  test('install: execFile di-inject — argv npm ci --ignore-scripts, cwd workspace, output clamp 4KB', async () => {
    const ws = makeNodeFixture();
    const calls = [];
    const fakeExecFile = (file, args, opts, cb) => {
      calls.push({ file, args, opts });
      cb(null, 'x'.repeat(5000), ''); // > 4KB untuk uji clamp
    };
    const res = await new NodeAdapter({ workspacePath: ws }).install({}, { execFile: fakeExecFile });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    const expectedExe = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    assert.equal(calls[0].file, expectedExe);
    assert.deepEqual(calls[0].args, ['ci', '--ignore-scripts']);
    assert.equal(calls[0].opts.cwd, ws);
    assert.ok(calls[0].opts.timeout <= 120_000);
    assert.ok(res.output.length <= 4096, `output: ${res.output.length}`);
  });

  test('install: kegagalan execFile → { ok: false } (tidak crash)', async () => {
    const ws = makeNodeFixture();
    const failing = (file, args, opts, cb) => cb(new Error('npm boom'));
    const res = await new NodeAdapter({ workspacePath: ws }).install({}, { execFile: failing });
    assert.equal(res.ok, false);
    assert.ok(res.output.includes('npm boom'));
  });
});

// ---------------------------------------------------------------- python
describe('python adapter', () => {
  function makePythonFixture({ withRequirements = false } = {}) {
    const ws = path.join(dir, `py-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'main.py'), 'print("py fixture ok")');
    if (withRequirements) {
      fs.writeFileSync(path.join(ws, 'requirements.txt'), 'flask==3.0.0\n');
    }
    return ws;
  }

  test('detect: requirements.txt ATAU entry py', () => {
    assert.equal(new PythonAdapter().detect({ workspacePath: makePythonFixture() }), true);
    const wsR = makePythonFixture();
    fs.rmSync(path.join(wsR, 'main.py'));
    fs.writeFileSync(path.join(wsR, 'requirements.txt'), 'requests\n');
    assert.equal(new PythonAdapter().detect({ workspacePath: wsR }), true);
    assert.equal(new PythonAdapter().detect({ workspacePath: dir }), false);
  });

  test('validate: tanpa config.main → VALIDATION', () => {
    const ws = makePythonFixture();
    assertVmPanelError(
      () => new PythonAdapter({ workspacePath: ws }).validate({}),
      VALIDATION, 'main',
    );
  });

  test('validate ok dengan config.main; pythonBin sesuai platform', () => {
    const ws = makePythonFixture();
    const ad = new PythonAdapter({ workspacePath: ws });
    const v = ad.validate({ main: 'main.py' });
    assert.equal(v.ok, true);
    assert.equal(v.main, 'main.py');
    const expectedBin = process.platform === 'win32' ? 'python' : 'python3';
    assert.equal(v.pythonBin, expectedBin);
    assert.equal(ad.pythonBin({ pythonBin: '/usr/bin/py-custom' }), '/usr/bin/py-custom');
  });

  test('venv python path benar sesuai platform; startSpec pakai venv python', () => {
    const ws = makePythonFixture();
    const ad = new PythonAdapter({ workspacePath: ws });
    const spec = ad.startSpec({ workspacePath: ws, config: { main: 'main.py', port: 8140 } });
    const expectedPy = process.platform === 'win32'
      ? path.join(ws, '.venv', 'Scripts', 'python.exe')
      : path.join(ws, '.venv', 'bin', 'python');
    assert.equal(spec.argv[0], expectedPy);
    assert.equal(spec.argv[1], path.join(ws, 'main.py'));
    assert.equal(spec.cwd, ws);
    assert.deepEqual(spec.env, { PORT: '8140' });
    assert.equal(spec.port, 8140);
    // path helper pip juga sesuai platform
    const expectedPip = process.platform === 'win32'
      ? path.join(ws, '.venv', 'Scripts', 'pip.exe')
      : path.join(ws, '.venv', 'bin', 'pip');
    assert.equal(ad.venvPipPath(ws), expectedPip);
  });

  test('install (injected): venv + pip install -r requirements.txt; skip pip bila tidak ada', async () => {
    const wsWith = makePythonFixture({ withRequirements: true });
    const calls = [];
    const fake = (file, args, opts, cb) => {
      calls.push({ file, args });
      cb(null, 'ok', '');
    };
    const ad = new PythonAdapter({ workspacePath: wsWith, config: { pythonBin: 'py-fake' } });
    const res = await ad.install({ workspacePath: wsWith }, { execFile: fake });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, 'py-fake');
    assert.deepEqual(calls[0].args, ['-m', 'venv', path.join(wsWith, '.venv')]);
    assert.equal(calls[1].file, ad.venvPipPath(wsWith));
    assert.deepEqual(calls[1].args, ['install', '-r', path.join(wsWith, 'requirements.txt')]);
    assert.ok(res.steps.length === 2);
    assert.ok(res.output.length <= 4096);

    // tanpa requirements.txt → hanya langkah venv
    const wsNo = makePythonFixture();
    calls.length = 0;
    const res2 = await new PythonAdapter({ workspacePath: wsNo, config: { pythonBin: 'py-fake' } })
      .install({ workspacePath: wsNo }, { execFile: fake });
    assert.equal(res2.ok, true);
    assert.equal(calls.length, 1);
  });

  test('install: python tidak ada (ENOENT) → VALIDATION "python not found"', async () => {
    const ws = makePythonFixture();
    const enoent = (file, args, opts, cb) => {
      const e = new Error(`spawn ${file} ENOENT`);
      e.code = 'ENOENT';
      cb(e);
    };
    await assertVmPanelErrorAsync(
      () => new PythonAdapter({ workspacePath: ws }).install({ workspacePath: ws }, { execFile: enoent }),
      VALIDATION, 'python not found',
    );
  });

  test('install: kegagalan venv non-ENOENT → { ok: false } (tidak crash)', async () => {
    const ws = makePythonFixture();
    const failing = (file, args, opts, cb) => cb(new Error('venv boom'));
    const res = await new PythonAdapter({ workspacePath: ws, config: { pythonBin: 'py-fake' } })
      .install({ workspacePath: ws }, { execFile: failing });
    assert.equal(res.ok, false);
    assert.ok(res.output.includes('venv boom'));
  });
});
