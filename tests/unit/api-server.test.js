// tests/unit/api-server.test.js — Manager + createApiServer end-to-end di
// sandbox tmp (node:test, fetch bawaan). Loopback-only, bearer auth,
// status/info/health/projects/audit, 404, rate limit 429.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager } from '../../manager/index.js';
import { isLoopbackAddress } from '../../manager/api.js';

const tmpRoot = join(tmpdir(), 'vmpanel-api-test');
mkdirSync(tmpRoot, { recursive: true });
let dir;
let manager;
let port;
let base;
let token;

function randomHighPort() {
  // 20000-29999 — port acak tinggi 2xxxx, hindari bentrok layanan dev
  return 20000 + Math.floor(Math.random() * 10000);
}

const H = (t) => ({ Authorization: `Bearer ${t}` });

before(() => {
  dir = mkdtempSync(join(tmpRoot, 'run-'));
});

after(async () => {
  if (manager && manager.running) await manager.stop();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // port acak tinggi 2xxxx per test-run; retry dengan port baru bila EADDRINUSE
  let started = false;
  for (let attempt = 0; attempt < 5 && !started; attempt++) {
    manager = new Manager({
      rootDir: dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'test-token-dummy-0123456789abcdef',
    });
    try {
      await manager.start();
      started = true;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  port = manager.api.port;
  base = `http://127.0.0.1:${port}`;
  token = manager.token;
});

afterEach(async () => {
  if (manager && (manager.running || manager.api)) {
    await manager.stop();
  }
});

describe('auth', () => {
  test('GET /health tanpa token → 401 {error:{code:PERMISSION_DENIED}}', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error.code, 'PERMISSION_DENIED');
    assert.ok(!JSON.stringify(body).includes('stack'));
  });

  test('GET /health token salah → 401', async () => {
    const r = await fetch(`${base}/health`, { headers: H('wrong-token') });
    assert.equal(r.status, 401);
  });

  test('GET /health dengan token valid → 200 {ok:true}', async () => {
    const r = await fetch(`${base}/health`, { headers: H(token) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await r.json();
    assert.equal(body.ok, true);
  });
});

describe('routes', () => {
  test('GET /system/status → field lengkap', async () => {
    const r = await fetch(`${base}/system/status`, { headers: H(token) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'running');
    assert.equal(typeof body.uptimeSec, 'number');
    assert.ok(body.uptimeSec >= 0);
    assert.equal(body.pid, process.pid);
    assert.equal(body.hostMode, 'dev');
    assert.equal(body.runnerId, 'local');
    assert.ok(body.startedAt);
    assert.equal(typeof body.version, 'string');
  });

  test('GET /system/info → name/version/dataDir/ports', async () => {
    const r = await fetch(`${base}/system/info`, { headers: H(token) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.name, 'VM-Panel');
    assert.equal(body.version, manager.version);
    assert.equal(body.dataDir, join(dir, 'data'));
    assert.ok(body.ports && typeof body.ports === 'object');
  });

  test('GET /projects → [] (projects.db kosong)', async () => {
    const r = await fetch(`${base}/projects`, { headers: H(token) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, []);
  });

  test('route tak dikenal → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/nope/route`, { headers: H(token) });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  test('GET /audit → list audit (minimal event system.startup)', async () => {
    const r = await fetch(`${base}/audit`, { headers: H(token) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.rows));
    assert.ok(body.total >= 1);
    const ops = body.rows.map((x) => x.operation);
    assert.ok(ops.includes('system.startup'));
  });

  test('GET /audit?limit=bad → 400 VALIDATION', async () => {
    const r = await fetch(`${base}/audit?limit=abc`, { headers: H(token) });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.code, 'VALIDATION');
  });
});

describe('loopback-only (handler direct — non-loopback rejection)', () => {
  test('isLoopbackAddress: loopback diterima, publik ditolak', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('127.1.2.3'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('0.0.0.0'), false);
    assert.equal(isLoopbackAddress('192.168.1.10'), false);
    assert.equal(isLoopbackAddress('8.8.8.8'), false);
    assert.equal(isLoopbackAddress('::ffff:192.168.1.10'), false);
    assert.equal(isLoopbackAddress(''), false);
    assert.equal(isLoopbackAddress(null), false);
  });

  test('handler langsung: remoteAddress non-loopback → 403 sebelum auth', async () => {
    // Simulasi non-loopback: panggil handler dengan socket remoteAddress publik.
    // Middleware (1) harus menolak 403 sebelum auth/routing dijalankan.
    const sink = new WritableSink();
    await manager.api.handler(
      {
        method: 'GET',
        url: '/health',
        headers: { authorization: `Bearer ${token}` },
        socket: { remoteAddress: '192.168.1.50' },
      },
      sink,
    );
    assert.equal(sink.status, 403);
    assert.equal(sink.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('rate limit — 60 req/menit', () => {
  test('61 request cepat → minimal satu 429', async () => {
    let saw429 = false;
    let okCount = 0;
    for (let i = 0; i < 61; i++) {
      const r = await fetch(`${base}/health`, { headers: H(token) });
      if (r.status === 429) {
        saw429 = true;
        break; // window sliding: begitu ter-limit, stop hammering
      }
      if (r.status === 200) okCount++;
    }
    assert.ok(saw429, `harus ada 429; jumlah 200 = ${okCount}`);
  });
});

describe('lifecycle — PID file & stop bersih', () => {
  test('start menulis runtime/pid/manager.pid, stop menghapusnya', async () => {
    const pidPath = join(dir, 'runtime', 'pid', 'manager.pid');
    assert.ok(existsSync(pidPath), 'PID file harus ada saat running');
    assert.equal(Number(readFileSync(pidPath, 'utf8').trim()), process.pid);
    await manager.stop();
    assert.equal(existsSync(pidPath), false, 'PID file dihapus setelah stop');
    // stop kedua tidak throw (idempotent-safe)
    await manager.stop();
  });
});

/** Response sink sederhana untuk memanggil handler secara langsung. */
class WritableSink {
  constructor() {
    this.status = null;
    this.body = null;
    this.headers = {};
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  end(body) {
    this.body = body ? JSON.parse(body) : null;
    return this;
  }
}
