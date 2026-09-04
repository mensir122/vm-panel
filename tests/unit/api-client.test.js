// tests/unit/api-client.test.js — unit test lib/api-client.js (docs/DESIGN.md §2.3).
// Mock manager: http server bawaan Node di port acak (listen(0)).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  ManagerClient,
  DEFAULT_PORT,
  TIMEOUT,
  UNREACHABLE,
} from '../../lib/api-client.js';
import { VmPanelError, isVmPanelError, VALIDATION } from '../../lib/errors.js';

/** Start mock manager di port acak; kembalikan {server, port, hits, close}. */
async function startMockManager(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      handler(req, res, body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    port: server.address().port,
    hits,
    close: async () => {
      server.close();
      server.closeAllConnections?.();
      await once(server, 'close');
    },
  };
}

const SYSTEM_STATUS_PAYLOAD = {
  status: 'running',
  uptimeSec: 123,
  pid: 4242,
  hostMode: 'actions',
  runnerId: 'rnr_abc123',
  startedAt: '2026-09-03T00:00:00.000Z',
  version: '0.1.0',
};

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('ManagerClient: konstruksi', () => {
  test('port default 8097 (kontrak §2.3)', () => {
    assert.equal(DEFAULT_PORT, 8097);
    const c = new ManagerClient();
    assert.ok(c instanceof ManagerClient);
  });

  test('port invalid → VmPanelError VALIDATION', () => {
    for (const port of [0, -1, 70000, 'abc']) {
      assert.throws(() => new ManagerClient({ port }), (e) => isVmPanelError(e) && e.code === VALIDATION);
    }
  });

  test('timeoutMs invalid → VmPanelError VALIDATION', () => {
    for (const t of [0, -5, 'x']) {
      assert.throws(() => new ManagerClient({ timeoutMs: t }), (e) => isVmPanelError(e) && e.code === VALIDATION);
    }
  });

  test('path tanpa leading slash → VmPanelError VALIDATION', async () => {
    const c = new ManagerClient({ token: 't' });
    await assert.rejects(() => c.request('GET', 'system/status'), (e) => isVmPanelError(e) && e.code === VALIDATION);
  });
});

describe('ManagerClient: ok path', () => {
  test('GET /health → {ok:true} di-parse', async () => {
    const m = await startMockManager((req, res) => json(res, 200, { ok: true }));
    try {
      const res = await new ManagerClient({ port: m.port, token: 'tok-1' }).health();
      assert.deepEqual(res, { ok: true });
      assert.equal(m.hits.length, 1);
      assert.equal(m.hits[0].method, 'GET');
      assert.equal(m.hits[0].url, '/health');
    } finally { await m.close(); }
  });

  test('Authorization bearer terkirim', async () => {
    const m = await startMockManager((req, res) => json(res, 200, SYSTEM_STATUS_PAYLOAD));
    try {
      await new ManagerClient({ port: m.port, token: 'secret-token-xyz' }).systemStatus();
      assert.equal(m.hits[0].headers.authorization, 'Bearer secret-token-xyz');
    } finally { await m.close(); }
  });

  test('tanpa token → header Authorization tidak dikirim', async () => {
    const m = await startMockManager((req, res) => json(res, 200, {}));
    try {
      await new ManagerClient({ port: m.port }).request('GET', '/x');
      assert.equal('authorization' in m.hits[0].headers, false);
    } finally { await m.close(); }
  });

  test('GET /system/status → payload lengkap', async () => {
    const m = await startMockManager((req, res) => json(res, 200, SYSTEM_STATUS_PAYLOAD));
    try {
      const res = await new ManagerClient({ port: m.port, token: 't' }).systemStatus();
      assert.deepEqual(res, SYSTEM_STATUS_PAYLOAD);
    } finally { await m.close(); }
  });

  test('query object → URLSearchParams di URL', async () => {
    const m = await startMockManager((req, res) => json(res, 200, { rows: [], total: 0 }));
    try {
      const c = new ManagerClient({ port: m.port, token: 't' });
      await c.listAudit({ limit: 5, offset: 10, actor: 'vmctl', projectId: undefined });
      const u = new URL(`http://127.0.0.1:${m.port}${m.hits[0].url}`);
      assert.equal(u.pathname, '/audit');
      assert.equal(u.searchParams.get('limit'), '5');
      assert.equal(u.searchParams.get('offset'), '10');
      assert.equal(u.searchParams.get('actor'), 'vmctl');
      assert.equal(u.searchParams.has('projectId'), false);
    } finally { await m.close(); }
  });

  test('body object → JSON body + Content-Type terkirim', async () => {
    const m = await startMockManager((req, res) => json(res, 200, { ok: true }));
    try {
      const c = new ManagerClient({ port: m.port, token: 't' });
      await c.request('POST', '/things', { body: { name: 'x', n: 3 } });
      assert.equal(m.hits[0].method, 'POST');
      assert.equal(m.hits[0].headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(m.hits[0].body), { name: 'x', n: 3 });
    } finally { await m.close(); }
  });
});

describe('ManagerClient: error path', () => {
  test('403 {error:{code,message}} → VmPanelError code dari body', async () => {
    const m = await startMockManager((req, res) => json(res, 403, { error: { code: 'PERMISSION_DENIED', message: 'x' } }));
    try {
      const c = new ManagerClient({ port: m.port, token: 't' });
      await assert.rejects(
        () => c.listProjects(),
        (e) => {
          assert.ok(e instanceof VmPanelError);
          assert.equal(e.code, 'PERMISSION_DENIED');
          assert.equal(e.message, 'x');
          assert.equal(e.details.status, 403);
          assert.equal(e.details.message, 'x');
          return true;
        },
      );
    } finally { await m.close(); }
  });

  test('error tanpa body code → fallback HTTP_STATUS map (400→VALIDATION, 404→NOT_FOUND)', async () => {
    const m = await startMockManager((req, res) => {
      if (req.url === '/bad') { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad'); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('gone');
    });
    try {
      const c = new ManagerClient({ port: m.port, token: 't' });
      await assert.rejects(() => c.request('GET', '/bad'), (e) => isVmPanelError(e) && e.code === VALIDATION);
      await assert.rejects(() => c.request('GET', '/missing'), (e) => isVmPanelError(e) && e.code === 'NOT_FOUND');
    } finally { await m.close(); }
  });

  test('status tak terpetakan (500) → code sintetis HTTP_500', async () => {
    const m = await startMockManager((req, res) => { res.writeHead(500); res.end('boom'); });
    try {
      const c = new ManagerClient({ port: m.port, token: 't' });
      await assert.rejects(() => c.request('GET', '/x'), (e) => isVmPanelError(e) && e.code === 'HTTP_500');
    } finally { await m.close(); }
  });

  test('timeout → VmPanelError TIMEOUT', async () => {
    const m = await startMockManager((req, res) => {
      // sengaja tidak pernah merespons
    });
    try {
      const c = new ManagerClient({ port: m.port, token: 't', timeoutMs: 150 });
      await assert.rejects(() => c.health(), (e) => isVmPanelError(e) && e.code === TIMEOUT);
    } finally { await m.close(); }
  });

  test('connection refused (manager mati) → VmPanelError UNREACHABLE', async () => {
    // amankan port: bind dulu, lalu tutup → port likely bebas
    const s = http.createServer(() => {});
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    const deadPort = s.address().port;
    s.close();
    await once(s, 'close');
    const c = new ManagerClient({ port: deadPort, token: 't', timeoutMs: 2000 });
    await assert.rejects(() => c.health(), (e) => isVmPanelError(e) && e.code === UNREACHABLE);
  });
});
