// tests/unit/assistant.test.js — Unit test untuk Hermes Agent & 9Router Assistant bridge
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAssistantStatus, handleAssistantChat } from '../../panel/server/assistant.js';
import { PanelServer } from '../../panel/server/index.js';
import { totpGenerate } from '../../lib/crypto.js';

describe('assistant.js bridge', () => {
  let mockServer;
  let mockPort;
  let mockResponses = {};

  before(async () => {
    // Jalankan server mock untuk mensimulasikan Hermes Gateway dan 9Router
    mockServer = http.createServer((req, res) => {
      const url = req.url;
      if (mockResponses[url]) {
        const resp = mockResponses[url];
        res.writeHead(resp.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resp.body));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = mockServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (mockServer) {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('getAssistantStatus returns expected shape', async () => {
    const st = await getAssistantStatus();
    assert.strictEqual(typeof st.available, 'boolean');
    assert.ok(['hermes', '9router-fallback', 'offline'].includes(st.mode));
    assert.strictEqual(typeof st.gatewayOnline, 'boolean');
    assert.strictEqual(typeof st.routerOnline, 'boolean');
    assert.ok(st.gatewayUrl);
    assert.ok(st.routerUrl);
  });

  test('handleAssistantChat rejects empty or invalid message', async () => {
    const { Readable } = await import('node:stream');

    // 1. Invalid JSON
    const reqInvalid = Readable.from(['{invalid-json']);
    let resData = '';
    const fakeRes = {
      writeHead: (code) => { fakeRes.statusCode = code; },
      end: (str) => { resData = str; },
    };

    await handleAssistantChat(reqInvalid, fakeRes);
    assert.strictEqual(fakeRes.statusCode, 400);
    const errObj = JSON.parse(resData);
    assert.ok(errObj.error);

    // 2. Empty message
    let resData2 = '';
    const fakeRes2 = {
      writeHead: (code) => { fakeRes2.statusCode = code; },
      end: (str) => { resData2 = str; },
    };
    const reqEmpty = Readable.from([JSON.stringify({ message: '   ' })]);

    await handleAssistantChat(reqEmpty, fakeRes2);
    assert.strictEqual(fakeRes2.statusCode, 400);
  });

  test('handleAssistantChat provides informative fallback when offline', async () => {
    const { Readable } = await import('node:stream');
    let resData = '';
    const fakeRes = {
      writeHead: (code) => { fakeRes.statusCode = code; },
      end: (str) => { resData = str; },
    };
    const reqValid = Readable.from([JSON.stringify({ message: 'Halo Hermes' })]);

    await handleAssistantChat(reqValid, fakeRes);
    assert.strictEqual(fakeRes.statusCode, 200);
    const result = JSON.parse(resData);
    assert.ok(result.reply && typeof result.reply === 'string');
    assert.ok(result.source);
  });
});

describe('PanelServer /api/assistant endpoints', () => {
  let sandboxDir;
  let panelServer;
  let panelPort;
  let sessionCookie = '';

  before(async () => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'vpanel-assistant-test-'));
    panelServer = new PanelServer({
      dataDir: sandboxDir,
      config: {
        panel: { port: 0, ratePerMin: 1000 },
        manager: { apiPort: 8097 },
      },
    });
    const addr = await panelServer.start();
    panelPort = addr.port;

    // Bootstrap owner
    const owner = panelServer.auth.bootstrapOwner({ username: 'testowner', password: 'password123' });
    const totp = totpGenerate(owner.totpSecretBase32);

    // Login via POST /login
    const loginRes = await fetch(`http://127.0.0.1:${panelPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'testowner',
        password: 'password123',
        totp,
      }),
      redirect: 'manual',
    });

    const cookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
    for (const c of cookies) {
      if (c.includes('vpanel_session=')) {
        sessionCookie = c.split(';')[0];
      }
    }
  });

  after(async () => {
    if (panelServer) await panelServer.close();
    if (sandboxDir) rmSync(sandboxDir, { recursive: true, force: true });
  });

  test('GET /api/assistant/status requires authentication', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/status`, {
      redirect: 'manual',
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login');
  });

  test('GET /api/assistant/status returns status when authenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/status`, {
      headers: { Cookie: sessionCookie },
      redirect: 'manual',
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.available, 'boolean');
    assert.ok(data.gatewayUrl);
  });

  test('POST /api/assistant/chat returns response when authenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Halo Hermes' }),
      redirect: 'manual',
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.reply);
  });
});
