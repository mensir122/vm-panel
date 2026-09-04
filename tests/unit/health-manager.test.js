// tests/unit/health-manager.test.js — HealthManager: semua tipe check,
// recordCheck state machine, redaction, alert, close (node:test).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { HealthManager } from '../../manager/health_manager/index.js';
import { VmPanelError, VALIDATION } from '../../lib/errors.js';

const tmpRoot = join(tmpdir(), 'vmpanel-health-mgr-test');
mkdirSync(tmpRoot, { recursive: true });

/** Server HTTP bawaan yang balas 200 'ok' pada port acak. */
function startHttpServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Squat satu port (listen lalu berhenti accept) → tcp check harus ok. */
function squatPort() {
  return new Promise((resolve) => {
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** Cari PID yang pasti sudah mati: spawn proses sesaat lalu tunggu exit. */
function spawnDeadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.exit(0)'],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('exit', () => resolve(child.pid));
    child.on('error', reject);
  });
}

const dir = mkdtempSync(join(tmpRoot, 'run-'));
const mgr = new HealthManager({ dataDir: dir });

after(async () => {
  mgr.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('HealthManager.runCheck — http', () => {
  let server;
  let port;
  let base;

  before(async () => {
    server = await startHttpServer();
    port = server.address().port;
    base = `http://127.0.0.1:${port}/health`;
  });

  after(() => {
    server.close();
  });

  test('http ok → {ok:true, latencyMs>0}', async () => {
    const out = await mgr.runCheck({
      serviceId: 'svc_http',
      projectId: 'prj_http',
      check: { type: 'http', url: base },
    });
    assert.equal(out.ok, true);
    assert.equal(out.type, 'http');
    assert.equal(out.result, 'ok');
    assert.ok(out.latencyMs > 0, `latencyMs harus > 0, dapat ${out.latencyMs}`);
    assert.equal(out.error, null);
  });

  test('http expectStatus mismatch → fail', async () => {
    const out = await mgr.runCheck({
      serviceId: 'svc_http',
      check: { type: 'http', url: base, expectStatus: 204 },
    });
    assert.equal(out.ok, false);
    assert.equal(out.result, 'fail');
    assert.match(out.error, /expectStatus/);
  });

  test('http expectContent regex match → ok; tidak match → fail', async () => {
    const match = await mgr.runCheck({
      serviceId: 'svc_http',
      check: { type: 'http', url: base, expectContent: '^ok$' },
    });
    assert.equal(match.ok, true);

    const miss = await mgr.runCheck({
      serviceId: 'svc_http',
      check: { type: 'http', url: base, expectContent: '^goodbye$' },
    });
    assert.equal(miss.ok, false);
    assert.match(miss.error, /expectContent/);
  });

  test('http expectContent pattern > 256 char → VALIDATION', async () => {
    await assert.rejects(
      () =>
        mgr.runCheck({
          serviceId: 'svc_http',
          check: { type: 'http', url: base, expectContent: 'a'.repeat(257) },
        }),
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
    );
  });

  test('http url tidak ada → VALIDATION', async () => {
    await assert.rejects(
      () => mgr.runCheck({ serviceId: 'svc_http', check: { type: 'http' } }),
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
    );
  });
});

describe('HealthManager.runCheck — tcp', () => {
  test('tcp ke port yang disquat → ok', async () => {
    const { srv, port } = await squatPort();
    try {
      const out = await mgr.runCheck({
        serviceId: 'svc_tcp',
        check: { type: 'tcp', port },
      });
      assert.equal(out.ok, true);
      assert.ok(out.latencyMs >= 0);
    } finally {
      srv.close();
    }
  });

  test('tcp ke port mati → fail', async () => {
    const { srv, port } = await squatPort();
    const deadPort = port;
    srv.close();
    await new Promise((r) => srv.close(r)); // pastikan benar-benar bebas
    const out = await mgr.runCheck({
      serviceId: 'svc_tcp',
      check: { type: 'tcp', port: deadPort, timeoutMs: 1000 },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /tcp/);
  });

  test('tcp port tidak valid → VALIDATION', async () => {
    await assert.rejects(
      () => mgr.runCheck({ serviceId: 'svc_tcp', check: { type: 'tcp', port: 70000 } }),
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
    );
  });
});

describe('HealthManager.runCheck — command', () => {
  test("command ['node','-e','process.exit(0)'] → ok", async () => {
    const out = await mgr.runCheck({
      serviceId: 'svc_cmd',
      check: { type: 'command', argv: ['node', '-e', 'process.exit(0)'] },
    });
    assert.equal(out.ok, true);
  });

  test("command exit 1 → fail dengan error exit code", async () => {
    const out = await mgr.runCheck({
      serviceId: 'svc_cmd',
      check: { type: 'command', argv: ['node', '-e', 'process.exit(1)'] },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /exit 1/);
  });
});

describe('HealthManager.runCheck — db & process', () => {
  test('db check ke sqlite valid → ok', async () => {
    const dbPath = join(dir, 'valid.db');
    const d = new Database(dbPath);
    d.exec('CREATE TABLE IF NOT EXISTS t (x)');
    d.close();
    const out = await mgr.runCheck({
      serviceId: 'svc_db',
      check: { type: 'db', dbPath },
    });
    assert.equal(out.ok, true);
  });

  test('db check ke file teks → fail (bukan throw)', async () => {
    const p = join(dir, 'plain.txt');
    writeFileSync(p, 'this is not a sqlite file at all');
    const out = await mgr.runCheck({
      serviceId: 'svc_db',
      check: { type: 'db', dbPath: p },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /db/);
  });

  test('process check pid sendiri → ok', async () => {
    const out = await mgr.runCheck({
      serviceId: 'svc_proc',
      check: { type: 'process', pid: process.pid },
    });
    assert.equal(out.ok, true);
  });

  test('process check pid yang sudah exit → fail', async () => {
    const deadPid = await spawnDeadPid();
    const out = await mgr.runCheck({
      serviceId: 'svc_proc',
      check: { type: 'process', pid: deadPid },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /tidak ditemukan|not found|pid/i);
  });
});

describe('HealthManager.runCheck — type unknown → VALIDATION', () => {
  test("type 'smtp' → VALIDATION", async () => {
    await assert.rejects(
      () => mgr.runCheck({ serviceId: 'svc_x', check: { type: 'smtp', pid: 1 } }),
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
    );
  });
});

describe('HealthManager.recordCheck — state machine', () => {
  test('3 fail berturut → unhealthy, unhealthy, failed; ok setelahnya → healthy + reset', async () => {
    const svc = 'svc_state';
    const outcome = { ok: false, latencyMs: 5, error: 'down' };
    const r1 = mgr.recordCheck({ serviceId: svc, check: { type: 'http' }, outcome });
    assert.equal(r1.status, 'unhealthy');
    assert.equal(r1.consecutiveFailures, 1);
    const r2 = mgr.recordCheck({ serviceId: svc, check: { type: 'http' }, outcome });
    assert.equal(r2.status, 'unhealthy');
    assert.equal(r2.consecutiveFailures, 2);
    const r3 = mgr.recordCheck({ serviceId: svc, check: { end: 1, type: 'http' }, outcome });
    assert.equal(r3.status, 'failed');
    assert.equal(r3.consecutiveFailures, 3);

    const st = mgr.getStatus(svc);
    assert.equal(st.status, 'failed');
    assert.equal(st.consecutive_failures, 3);
    assert.ok(st.last_check_at, 'last_check_at terisi');
    assert.ok(st.last_check_at.endsWith('Z'), 'UTC ISO Z');
    assert.equal(st.last_healthy_at, null);

    // ok → healthy + reset
    const r4 = mgr.recordCheck({
      serviceId: svc,
      check: { type: 'http' },
      outcome: { ok: true, latencyMs: 7 },
    });
    assert.equal(r4.status, 'healthy');
    assert.equal(r4.consecutiveFailures, 0);
    const st2 = mgr.getStatus(svc);
    assert.equal(st2.status, 'healthy');
    assert.equal(st2.consecutive_failures, 0);
    assert.ok(st2.last_healthy_at, 'last_healthy_at terisi');
  });

  test('recordCheck outcome.ok bukan boolean → VALIDATION', () => {
    assert.throws(
      () => mgr.recordCheck({ serviceId: 'svc_v', check: { type: 'http' }, outcome: { ok: 'yes' } }),
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
    );
  });
});

describe('HealthManager — redaction, manual status, list, alert, close', () => {
  test('error "password: hunter2" tersimpan sebagai ***REDACTED***', () => {
    mgr.recordCheck({
      serviceId: 'svc_redact',
      check: { type: 'http' },
      outcome: { ok: false, latencyMs: 1, error: 'auth gagal: password: hunter2' },
    });
    const rows = mgr.listChecks({ serviceId: 'svc_redact', limit: 1 });
    assert.equal(rows.length, 1);
    assert.match(rows[0].error, /\*\*\*REDACTED\*\*\*/);
    assert.ok(!rows[0].error.includes('hunter2'), 'secret tidak boleh tersimpan');
  });

  test('error di-clamp 2KB', () => {
    const long = 'x'.repeat(5000) + ' password: y';
    mgr.recordCheck({
      serviceId: 'svc_redact',
      check: { type: 'http' },
      outcome: { ok: false, latencyMs: 1, error: long },
    });
    const [row] = mgr.listChecks({ serviceId: 'svc_redact', limit: 1 });
    assert.ok(row.error.length <= 2048, `error harus <= 2048, dapat ${row.error.length}`);
  });

  test('getStatus unknown + setStatus manual + validasi', () => {
    assert.equal(mgr.getStatus('svc_never').status, 'unknown');

    mgr.setStatus('svc_manual', 'starting');
    assert.equal(mgr.getStatus('svc_manual').status, 'starting');
    mgr.setStatus('svc_manual', 'recovering');
    assert.equal(mgr.getStatus('svc_manual').status, 'recovering');

    assert.throws(
      () => mgr.setStatus('svc_manual', 'healthy'), // bukan status manual
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
    );
  });

  test('listChecks terbaru dulu + limit', () => {
    for (let i = 0; i < 5; i++) {
      mgr.recordCheck({
        serviceId: 'svc_list',
        check: { type: 'http' },
        outcome: { ok: i === 4, latencyMs: i },
      });
      // i=0..3 fail (unhealthy), i=4 ok (healthy lagi)
    }
    const rows = mgr.listChecks({ serviceId: 'svc_list', limit: 3 });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].result, 'ok'); // terbaru dulu
  });

  test('raiseAlert / resolveAlert roundtrip', () => {
    const { id, at } = mgr.raiseAlert({
      projectId: 'prj_a',
      level: 'warning',
      code: 'SVC_DOWN',
      message: 'svc down: password: hunter2',
    });
    assert.ok(Number.isInteger(id) && id > 0);
    assert.match(at, /Z$/);
    const r = mgr.resolveAlert('SVC_DOWN');
    assert.ok(r.resolved >= 1);
    assert.ok(mgr.resolveAlert('SVC_DOWN').resolved === 0, 'idempotent setelah resolved');
  });

  test('close bersih: method setelah close → VALIDATION', () => {
    const d2 = mkdtempSync(join(tmpRoot, 'close-'));
    const m2 = new HealthManager({ dataDir: d2 });
    m2.close();
    m2.close(); // idempotent
    assert.throws(
      () => m2.getStatus('svc_any'),
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
    );
    rmSync(d2, { recursive: true, force: true });
  });
});
