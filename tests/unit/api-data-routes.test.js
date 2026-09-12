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
import { EventEmitter } from 'node:events';
import { Manager, installCrashGuards } from '../../manager/index.js';
import { registerDataRoutes } from '../../manager/api-data-routes.js';
import { acquire, release } from '../../lib/lock.js';
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

    // Filter by projectId query
    const srFiltered = await fetch(`${base}/services?projectId=${projectId}`, { headers: H(token) });
    assert.equal(srFiltered.status, 200);
    const sbFiltered = await srFiltered.json();
    assert.equal(sbFiltered.rows.length, 1);
    assert.equal(sbFiltered.rows[0].id, serviceId);

    // Filter with non-existent projectId
    const srNone = await fetch(`${base}/services?projectId=prj_non_existent_123`, { headers: H(token) });
    const sbNone = await srNone.json();
    assert.equal(sbNone.rows.length, 0);
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

  test('POST /projects/:id/remove-request & remove → project & services dibersihkan', async () => {
    const reqRes = await fetch(`${base}/projects/${projectId}/remove-request`, {
      method: 'POST',
      headers: H(token),
      body: '{}',
    });
    assert.equal(reqRes.status, 200);
    const rb = await reqRes.json();
    assert.ok(rb.confirmToken, 'confirmToken harus ada');

    const badRes = await fetch(`${base}/projects/${projectId}/remove`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ confirmToken: '' }),
    });
    assert.equal(badRes.status, 403);

    const okRes = await fetch(`${base}/projects/${projectId}/remove`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ confirmToken: rb.confirmToken }),
    });
    assert.equal(okRes.status, 200);
    const ob = await okRes.json();
    assert.equal(ob.removed, true);

    const getRes = await fetch(`${base}/projects/${projectId}`, { headers: H(token) });
    assert.equal(getRes.status, 404);
  });

  // ── Regresi bug-hunt god-mode lane M-A ──────────────────────────────────

  test('F1: POST /projects/:id/remove — token sampah DITOLAK 403 (consume nyata, bukan swallow)', async () => {
    const c = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ name: 'twophase-a', type: 'static' }),
    });
    assert.equal(c.status, 201);
    const p = await c.json();
    // fase 1
    const rr = await fetch(`${base}/projects/${p.id}/remove-request`, {
      method: 'POST',
      headers: H(token),
      body: '{}',
    });
    assert.equal(rr.status, 200);
    const good = (await rr.json()).confirmToken;
    // token garbage → 403 PERMISSION_DENIED (dulu: catch swallow → purge jalan!)
    const bad = await fetch(`${base}/projects/${p.id}/remove`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ confirmToken: 'cfgtok-garbage-garbage-garbage' }),
    });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).error.code, 'PERMISSION_DENIED');
    // project masih hidup
    assert.equal((await fetch(`${base}/projects/${p.id}`, { headers: H(token) })).status, 200);
    // token valid → 200 (sekali pakai)
    const ok = await fetch(`${base}/projects/${p.id}/remove`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ confirmToken: good }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).removed, true);
  });

  test('F1: DELETE /projects/:id wajib confirmToken + consume nyata', async () => {
    const c = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ name: 'twophase-b', type: 'static' }),
    });
    const p = await c.json();
    // tanpa body → 403 (dulu: purge langsung)
    const noTok = await fetch(`${base}/projects/${p.id}`, { method: 'DELETE', headers: H(token) });
    assert.equal(noTok.status, 403);
    assert.equal((await noTok.json()).error.code, 'PERMISSION_DENIED');
    // token garbage → 403
    const bad = await fetch(`${base}/projects/${p.id}`, {
      method: 'DELETE',
      headers: H(token),
      body: JSON.stringify({ confirmToken: 'cfgtok-tidak-kenal-sama-sekali' }),
    });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).error.code, 'PERMISSION_DENIED');
    // dua fase penuh: remove-request → DELETE dengan token
    const rr = await fetch(`${base}/projects/${p.id}/remove-request`, {
      method: 'POST',
      headers: H(token),
      body: '{}',
    });
    const { confirmToken } = await rr.json();
    assert.ok(String(confirmToken).startsWith('cfgtok-'), 'token berasal dari SecretManager');
    const ok = await fetch(`${base}/projects/${p.id}`, {
      method: 'DELETE',
      headers: H(token),
      body: JSON.stringify({ confirmToken }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).removed, true);
    assert.equal((await fetch(`${base}/projects/${p.id}`, { headers: H(token) })).status, 404);
  });

  test('F1: remove-request tanpa SecretManager → NOT_READY (fallback randomToken dihapus)', async () => {
    const routes = registerDataRoutes({
      manager: { projectManager: { getProject: () => ({ id: 'prj_A1B2C3D4E5', name: 'x' }) } },
    });
    const reqRoute = routes.find(
      (r) => r.method === 'POST' && r.pattern === '/projects/:id/remove-request',
    );
    assert.throws(
      () =>
        reqRoute.handler({
          params: { id: 'prj_A1B2C3D4E5' },
          url: null,
          body: null,
          user: 'system',
        }),
      (e) => e instanceof VmPanelError && e.code === 'NOT_READY',
    );
    const delRoute = routes.find((r) => r.method === 'DELETE' && r.pattern === '/projects/:id');
    await assert.rejects(
      () =>
        delRoute.handler({
          params: { id: 'prj_A1B2C3D4E5' },
          url: null,
          body: { confirmToken: 'cfgtok-x' },
          user: 'system',
        }),
      (e) => e instanceof VmPanelError && e.code === 'NOT_READY',
    );
  });

  test('serviceAction: permission PER-VERB sesuai matriks §11.2', () => {
    const routes = registerDataRoutes({ manager });
    for (const verb of ['start', 'stop', 'restart']) {
      const r = routes.find((x) => x.method === 'POST' && x.pattern === `/services/:id/${verb}`);
      assert.ok(r, `route /services/:id/${verb} harus ada`);
      assert.equal(r.permission, `service.${verb}`);
    }
  });

  test('serviceAction: lock svc-<id> dipegang pihak lain → LOCK_HELD pesan jelas', async () => {
    const routes = registerDataRoutes({ manager });
    const stopRoute = routes.find(
      (r) => r.method === 'POST' && r.pattern === '/services/:id/stop',
    );
    const fakeId = 'svc_TESTK0P3R1';
    const lockName = `svc-${fakeId}`;
    const lockDir = join(dir, 'runtime', 'locks');
    const tok = await acquire(lockName, { dir: lockDir, ttlMs: 30_000 });
    try {
      await assert.rejects(
        () => stopRoute.handler({ params: { id: fakeId }, url: null, body: null, user: 'system' }),
        (e) =>
          e instanceof VmPanelError &&
          e.code === 'LOCK_HELD' &&
          /sedang diproses aksi\/recovery lain/.test(e.message),
      );
    } finally {
      assert.equal(release(lockName, tok, { dir: lockDir }), true);
    }
    // setelah lock lepas → handler jalan lagi (service tak dikenal → NOT_FOUND)
    await assert.rejects(
      () => stopRoute.handler({ params: { id: fakeId }, url: null, body: null, user: 'system' }),
      (e) => e instanceof VmPanelError && e.code === 'NOT_FOUND',
    );
  });

  test('F13: audit field error di-clamp ≤2KB POST-redaksi', () => {
    assert.ok(manager.auditManager, 'auditManager harus hidup');
    const long = `password: bocor123 ${'E'.repeat(5000)}`;
    manager.auditManager.append({
      actor: 'system',
      operation: 'test.f13.clamp',
      error: long,
      result: 'error',
    });
    const { rows } = manager.auditManager.list({ operation: 'test.f13.clamp' });
    assert.equal(rows.length, 1);
    const err = rows[0].error;
    assert.ok(
      Buffer.byteLength(err, 'utf8') <= 2048,
      `harus ≤2048 byte, dapat ${Buffer.byteLength(err)}`,
    );
    assert.ok(err.includes('***REDACTED***'), 'redaksi jalan sebelum clamp');
    assert.ok(!err.includes('bocor123'), 'secret tidak boleh tersisa');
  });

  test('F7: installCrashGuards → log redacted + stop() sekali + exit terkontrol (guard reentrancy)', async () => {
    const emitter = new EventEmitter();
    let stops = 0;
    const exits = [];
    const logs = [];
    const fakeManager = {
      logger: { error: (msg, fields) => logs.push([msg, fields]) },
      stop: async () => {
        stops += 1;
      },
    };
    const { dispose } = installCrashGuards(fakeManager, {
      emitter,
      exit: (code) => exits.push(code),
    });
    try {
      emitter.emit('unhandledRejection', new Error('boom token=RAHASIA-X'));
      emitter.emit('unhandledRejection', new Error('dua-kali'));
      emitter.emit('uncaughtException', new Error('tiga-kali'));
      await new Promise((r) => setImmediate(r));
      assert.equal(stops, 1, 'stop() hanya sekali (guard reentrancy)');
      assert.deepEqual(exits, [1], 'exit(1) tepat satu kali');
      assert.equal(logs.length, 1);
      assert.equal(logs[0][0], 'manager.unhandled_rejection');
      assert.ok(!String(logs[0][1].reason).includes('RAHASIA-X'), 'reason harus teredaksi');
    } finally {
      dispose();
    }
  });
});
