// tests/unit/api-data-routes.test.js — F4 Wave 1 data routes end-to-end.
// Manager nyata via start() di sandbox (port acak), bootstrap project+service
// static, lalu fetch endpoint data: /services, /services/:id(+health),
// /deployments(+/:id), /health-state, /ports, /recovery/status,
// /recovery/retry, POST /projects, POST /projects/:id/deploy,
// POST /services/:id/stop, POST/GET /backups, GET /logs/:serviceId,
// token salah → 401, modul belum aktif → NOT_READY (handler langsung).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager } from '../../manager/index.js';
import { registerDataRoutes } from '../../manager/api-data-routes.js';
import { VmPanelError } from '../../lib/errors.js';

const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

function randomHighPort() {
  // 20000-29999 — hindari bentrok layanan dev
  return 20000 + Math.floor(Math.random() * 10000);
}

let dir;
let manager;
let base;
let token;
let svcPort;
let projectId;
let serviceId;
let deploymentId;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vmpanel-apidata-'));
  // Start manager di port acak; retry bila EADDRINUSE.
  for (let attempt = 0; attempt < 5; attempt++) {
    manager = new Manager({
      rootDir: dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'test-token-data-0123456789abcdef',
    });
    try {
      await manager.start();
      break;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  base = `http://127.0.0.1:${manager.api.port}`;
  token = manager.token;

  // Port bebas untuk service static (beda dari port API manager).
  for (let i = 0; i < 100; i++) {
    const p = randomHighPort();
    // eslint-disable-next-line no-await-in-loop
    if (p !== manager.api.port && (await manager.processManager.portBindTest(p))) {
      svcPort = p;
      break;
    }
  }
  if (!svcPort) throw new Error('tidak ada port bebas untuk service');
  mkdirSync(join(dir, 'logs', 'projects'), { recursive: true });
});

after(async () => {
  if (manager && manager.running) await manager.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('api-data-routes (F4 Wave 1)', () => {
  test('registerDataRoutes: modul belum aktif → handler throw NOT_READY', async () => {
    const routes = registerDataRoutes({ manager: {} });
    const list = routes.find((r) => r.method === 'GET' && r.pattern === '/services');
    assert.ok(list, 'route GET /services harus terdaftar');
    assert.throws(
      () => list.handler({ params: {}, url: new URL('http://127.0.0.1/services'), body: null }),
      (e) => e instanceof VmPanelError && e.code === 'NOT_READY',
    );
  });

  test('GET /services → 200 rows kosong di awal', async () => {
    const r = await fetch(`${base}/services`, { headers: H(token) });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.deepEqual(b.rows, []);
  });

  test('POST /projects → 201 + row; workspace siap untuk deploy', async () => {
    const r = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ name: 'data-site', type: 'static', port: svcPort }),
    });
    assert.equal(r.status, 201);
    const p = await r.json();
    assert.ok(p.id.startsWith('prj_'), 'id project prj_*');
    assert.equal(p.name, 'data-site');
    assert.equal(p.type, 'static');
    assert.equal(p.port, svcPort);
    assert.ok(p.workspacePath, 'workspacePath terisi');
    projectId = p.id;
    // fixture static site untuk deploy
    writeFileSync(
      join(p.workspacePath, 'index.html'),
      '<!doctype html><html><body>api-data-routes-test</body></html>\n',
    );
  });

  test('POST /projects/:id/deploy → success; service dibuat otomatis', async () => {
    const r = await fetch(`${base}/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: H(token),
      body: '{}',
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.status, 'success');
    assert.ok(String(d.deploymentId).startsWith('dep_'));
    assert.ok(d.revision);
    deploymentId = d.deploymentId;

    const sr = await fetch(`${base}/services`, { headers: H(token) });
    assert.equal(sr.status, 200);
    const sb = await sr.json();
    assert.ok(Array.isArray(sb.rows) && sb.rows.length >= 1);
    const svc = sb.rows.find((s) => s.projectId === projectId);
    assert.ok(svc, 'service untuk project harus ada');
    assert.equal(svc.status, 'running');
    serviceId = svc.id;
  });

  test('GET /services/:id → 200 record; GET /services/:id/health → ok', async () => {
    const r = await fetch(`${base}/services/${serviceId}`, { headers: H(token) });
    assert.equal(r.status, 200);
    const svc = await r.json();
    assert.equal(svc.id, serviceId);
    assert.equal(svc.type, 'static');
    assert.equal(svc.status, 'running');
    assert.equal(svc.port, svcPort);

    const hr = await fetch(`${base}/services/${serviceId}/health`, { headers: H(token) });
    assert.equal(hr.status, 200);
    const h = await hr.json();
    assert.equal(h.ok, true);
    assert.equal(h.type, 'http');
    assert.equal(h.result, 'ok');
  });

  test('GET /health-state?serviceId → status healthy + checks tercatat', async () => {
    const r = await fetch(`${base}/health-state?serviceId=${serviceId}`, { headers: H(token) });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.serviceId, serviceId);
    assert.equal(b.status.status, 'healthy');
    assert.ok(Array.isArray(b.checks) && b.checks.length >= 1, 'checks harus tercatat');
  });

  test('GET /deployments → rows; GET /deployments/:id → row + events; 404 untuk id tak ada', async () => {
    const r = await fetch(`${base}/deployments?projectId=${projectId}`, { headers: H(token) });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.ok(b.rows.length >= 1);
    assert.ok(b.rows.some((x) => x.id === deploymentId));

    const r2 = await fetch(`${base}/deployments/${deploymentId}`, { headers: H(token) });
    assert.equal(r2.status, 200);
    const d = await r2.json();
    assert.equal(d.id, deploymentId);
    assert.ok(Array.isArray(d.events) && d.events.length >= 1, 'events harus ada');

    const miss = await fetch(`${base}/deployments/dep_tidakada`, { headers: H(token) });
    assert.equal(miss.status, 404);
  });

  test('GET /ports → rows berisi port service', async () => {
    const r = await fetch(`${base}/ports`, { headers: H(token) });
    assert.equal(r.status, 200);
    const b = await r.json();
    const row = b.rows.find((x) => x.port === svcPort);
    assert.ok(row, 'ports row harus tercatat');
    assert.equal(row.service_id, serviceId);
  });

  test('GET /recovery/status → rows berisi supervisor state', async () => {
    const r = await fetch(`${base}/recovery/status`, { headers: H(token) });
    assert.equal(r.status, 200);
    const b = await r.json();
    const row = b.rows.find((x) => x.serviceId === serviceId);
    assert.ok(row, 'row service harus ada');
    assert.equal(row.status, 'running');
    assert.equal(typeof row.supervisor.restartCount, 'number');
    assert.equal(row.supervisor.crashLoop, false);
  });

  test('POST /recovery/retry → manualRetry dipanggil', async () => {
    const r = await fetch(`${base}/recovery/retry`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ serviceId }),
    });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.serviceId, serviceId);
    assert.equal(b.retried, true);
  });

  test('GET /logs/:serviceId → 404 tanpa file; 200 + tail dengan fixture', async () => {
    const miss = await fetch(`${base}/logs/${serviceId}`, { headers: H(token) });
    assert.equal(miss.status, 404);

    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
    writeFileSync(join(dir, 'logs', 'projects', `${serviceId}.log`), lines.join('\n') + '\n');
    const r = await fetch(`${base}/logs/${serviceId}`, { headers: H(token) });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.lines.length, 200, 'tail 200 baris');
    assert.equal(b.lines[0], 'line-51');
    assert.equal(b.lines[199], 'line-250');
    assert.equal(b.total, 250);
    assert.equal(b.truncated, true);
  });

  test('POST /services/:id/stop → status stopped', async () => {
    const r = await fetch(`${base}/services/${serviceId}/stop`, {
      method: 'POST',
      headers: H(token),
      body: '{}',
    });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.status, 'stopped');
    const svc = await (await fetch(`${base}/services/${serviceId}`, { headers: H(token) })).json();
    assert.equal(svc.status, 'stopped');
    assert.equal(svc.pid, null);
  });

  test('POST /backups → 201 valid; GET /backups → ada 1', async () => {
    const c = await fetch(`${base}/backups`, { method: 'POST', headers: H(token), body: '{}' });
    assert.equal(c.status, 201);
    const cb = await c.json();
    assert.ok(String(cb.backupId).startsWith('bak_'));
    assert.equal(cb.verification.ok, true, 'backup harus terverifikasi');

    const r = await fetch(`${base}/backups`, { headers: H(token) });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.ok(b.rows.length >= 1);
    assert.ok(b.rows.some((x) => x.id === cb.backupId));
  });

  test('token salah → 401', async () => {
    const r = await fetch(`${base}/services`, { headers: H('token-salah') });
    assert.equal(r.status, 401);
  });
});
