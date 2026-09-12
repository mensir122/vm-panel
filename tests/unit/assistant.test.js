// tests/unit/assistant.test.js — Unit test untuk Hermes Agent & 9Router Assistant bridge
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getAssistantStatus,
  handleAssistantChat,
  collectHostMetrics,
  detectSystemIntent,
  generateLocalAnswer,
  introspectWorkspaceCapabilities,
  executeVmPanelTool,
  VM_PANEL_TOOLS,
  buildAgentSystemPrompt,
  detectDeployIntent,
} from '../../panel/server/assistant.js';
import { PanelServer } from '../../panel/server/index.js';
import { totpGenerate } from '../../lib/crypto.js';

// Hermeticitas (A2#15): upstream diarahkan ke port tertutup supaya probe gagal cepat
// (ECONNREFUSED) dan jalur fallback lokal deterministik — test TIDAK BOLEH menyentuh
// LLM asli (latensi/non-deterministik). URL dibaca per-panggilan oleh assistant.js.
process.env.HERMES_GATEWAY_URL = 'http://127.0.0.1:1/v1';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.HERMES_CHAT_DEADLINE_MS = '5000';

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

  test('introspectWorkspaceCapabilities dynamically discovers repository capabilities', () => {
    const intro = introspectWorkspaceCapabilities();
    assert.ok(intro.version);
    assert.ok(intro.name === 'vm-panel');
    assert.ok(Array.isArray(intro.adapters));
    assert.ok(intro.adapters.includes('node'));
    assert.ok(intro.adapters.includes('python'));
    assert.ok(intro.adapters.includes('static'));
    assert.ok(intro.cliCommands.system);
    assert.ok(intro.cliCommands.project);
    assert.ok(intro.cliCommands.service);
    assert.ok(intro.docs.includes('DESIGN.md'));
    assert.ok(intro.skills.includes('vm-panel'));
  });

  test('buildAgentSystemPrompt includes dynamic introspection manifest and adaptation doctrine', () => {
    const metrics = collectHostMetrics();
    const prompt = buildAgentSystemPrompt(metrics, '- svc_1: running', '- proj_1: node');
    assert.ok(prompt.includes('KAPABILITAS DINAMIS & INTROSPEKSI SISTEM REAL-TIME'));
    assert.ok(prompt.includes('DOKTRIN CONTINUOUS ADAPTATION & ZERO RE-PROMPTING'));
    assert.ok(prompt.includes('Adapters Runtime Terdeteksi'));
    assert.ok(prompt.includes('Command CLI vmctl Terdeteksi'));
  });

  test('VM_PANEL_TOOLS includes dynamic introspection tools', () => {
    const toolNames = VM_PANEL_TOOLS.map((t) => t.function.name);
    assert.ok(toolNames.includes('introspect_architecture'));
    assert.ok(toolNames.includes('inspect_documentation'));
    assert.ok(toolNames.includes('execute_cli'));
    assert.ok(toolNames.includes('query_manager_route'));
    assert.ok(toolNames.includes('read_skill'));
  });

  test('executeVmPanelTool executes introspection and inspection tools', async () => {
    // 1. introspect_architecture
    const resIntro = await executeVmPanelTool('introspect_architecture');
    assert.strictEqual(resIntro.ok, true);
    assert.ok(resIntro.introspection.adapters.includes('node'));

    // 2. inspect_documentation
    const resDoc = await executeVmPanelTool('inspect_documentation', { docName: 'DESIGN.md', maxChars: 500 });
    assert.strictEqual(resDoc.ok, true);
    assert.strictEqual(resDoc.docName, 'DESIGN.md');
    assert.ok(resDoc.content.length > 0);

    // 3. read_skill
    const resSkill = await executeVmPanelTool('read_skill', { skillName: 'vm-panel' });
    assert.strictEqual(resSkill.ok, true);
    assert.ok(resSkill.content.includes('vm-panel'));

    // 4. execute_cli safe
    const resCliHelp = await executeVmPanelTool('execute_cli', { noun: 'help' });
    assert.strictEqual(resCliHelp.ok, true);

    // 5. execute_cli destructive blocks without confirmation
    const resCliDestructive = await executeVmPanelTool('execute_cli', { noun: 'project', verb: 'remove' });
    assert.strictEqual(resCliDestructive.ok, false);
    assert.strictEqual(resCliDestructive.blocked, true);
  });

  // A2#5/#6 — permission gate query_manager_route + tool aksi-tulis terikat sesi.
  const mockClient = (calls) => ({
    request: async (method, path, opts) => {
      calls.push({ method, path, opts });
      if (method === 'GET') return { rows: [{ id: 'srv_1', name: 'app-web', status: 'running' }] };
      return { ok: true };
    },
  });
  const ownerCtx = (calls) => ({
    managerClient: mockClient(calls),
    session: { userId: 1, role: 'owner' },
    checkPermission: () => true,
  });
  const viewerCtx = (calls) => ({
    managerClient: mockClient(calls),
    session: { userId: 2, role: 'viewer' },
    checkPermission: (action) => action.endsWith('.view') || action.startsWith('audit.'),
  });

  test('query_manager_route menolak method non-GET dan path aksi (A2#5/#6)', async () => {
    const calls = [];
    const ctx = ownerCtx(calls);
    const post = await executeVmPanelTool('query_manager_route', { method: 'POST', path: '/services/s1/start' }, ctx);
    assert.strictEqual(post.ok, false);
    assert.strictEqual(post.blocked, true);
    const del = await executeVmPanelTool('query_manager_route', { method: 'DELETE', path: '/projects/1' }, ctx);
    assert.strictEqual(del.blocked, true);
    // GET dengan kata aksi di path juga ditolak (denylist).
    const sneaky = await executeVmPanelTool('query_manager_route', { method: 'GET', path: '/projects/1/remove-all' }, ctx);
    assert.strictEqual(sneaky.blocked, true);
    assert.strictEqual(calls.length, 0, 'tidak boleh ada request manager lolos dari jalur yang ditolak');
  });

  test('GET list_services lolos untuk owner; aksi tulis ditolak untuk viewer tanpa izin (A2#5/#6)', async () => {
    const callsOwner = [];
    const svc = await executeVmPanelTool('list_services', {}, ownerCtx(callsOwner));
    assert.strictEqual(svc.ok, true);
    assert.ok(svc.services[0].name === 'app-web');
    assert.strictEqual(callsOwner[0].method, 'GET');

    const getRoute = await executeVmPanelTool(
      'query_manager_route',
      { method: 'GET', path: '/services' },
      viewerCtx([])
    );
    assert.strictEqual(getRoute.ok, true, 'jalur baca GET harus tetap lolos untuk viewer');

    const callsViewer = [];
    const stop = await executeVmPanelTool(
      'service_action',
      { serviceId: 'srv_1', action: 'stop' },
      viewerCtx(callsViewer)
    );
    assert.strictEqual(stop.ok, false);
    assert.strictEqual(stop.blocked, true);
    const dep = await executeVmPanelTool('deploy_project', { projectId: 'p1' }, viewerCtx(callsViewer));
    assert.strictEqual(dep.blocked, true);
    assert.strictEqual(callsViewer.length, 0, 'aksi yang diblok tidak boleh menyentuh manager');
  });

  test('tool aksi-tulis fail-closed tanpa checkPermission dan lolos dengan izin owner (A2#5/#6)', async () => {
    const callsNoCtx = [];
    const noCtx = { managerClient: mockClient(callsNoCtx) }; // tanpa sesi/gate → tolak
    const blocked = await executeVmPanelTool('service_action', { serviceId: 'srv_1', action: 'start' }, noCtx);
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(callsNoCtx.length, 0);

    const callsOwner = [];
    const okStart = await executeVmPanelTool(
      'service_action',
      { serviceId: 'srv_1', action: 'start' },
      ownerCtx(callsOwner)
    );
    assert.strictEqual(okStart.ok, true);
    assert.strictEqual(callsOwner[0].path, '/services/srv_1/start');
    const okDep = await executeVmPanelTool('deploy_project', { projectId: 'p1' }, ownerCtx(callsOwner));
    assert.strictEqual(okDep.ok, true);
  });

  // REM2 — gate JALUR BACA tool Hermes: rute sensitif wajib setara gerbang
  // halaman panel (secret.view / audit.view), bukan lolos hanya karena GET.
  // Matriks §11.2 nyata (manager/permission_manager/index.js): secret.view =
  // owner saja; audit.view = owner+operator; viewer hanya view non-sensitif.
  const MATRIX = {
    'project.view': ['owner', 'operator', 'viewer'],
    'service.logs.view': ['owner', 'operator', 'viewer'],
    'service.health.view': ['owner', 'operator', 'viewer'],
    'secret.view': ['owner'],
    'audit.view': ['owner', 'operator'],
  };
  const matrixCtx = (calls, role) => ({
    managerClient: mockClient(calls),
    session: { userId: role === 'owner' ? 1 : 2, role },
    checkPermission: (action) => (MATRIX[action] ?? []).includes(role),
  });

  test('REM2: query_manager_route rute sensitif ter-gate secret.view; rute biasa tetap lolos', async () => {
    const callsViewer = [];
    const sec = await executeVmPanelTool(
      'query_manager_route',
      { method: 'GET', path: '/secrets' },
      matrixCtx(callsViewer, 'viewer')
    );
    assert.strictEqual(sec.ok, false, 'viewer tidak boleh membaca vault via Hermes');
    assert.strictEqual(sec.blocked, true);
    assert.strictEqual(callsViewer.length, 0, 'path yang diblok tidak boleh menyentuh manager');

    const callsOp = [];
    const cfg = await executeVmPanelTool(
      'query_manager_route',
      { method: 'GET', path: '/projects/p1/config/index.js' },
      matrixCtx(callsOp, 'operator')
    );
    assert.strictEqual(cfg.blocked, true, 'isi config file (contentBase64) ikut ter-gate');

    const callsSvc = [];
    const svc = await executeVmPanelTool(
      'query_manager_route',
      { method: 'GET', path: '/services' },
      viewerCtx(callsSvc)
    );
    assert.strictEqual(svc.ok, true, 'rute baca non-sensitif tetap lolos untuk viewer');
    assert.strictEqual(callsSvc[0].path, '/services');

    const callsOwner = [];
    const secOwner = await executeVmPanelTool(
      'query_manager_route',
      { method: 'GET', path: '/secrets' },
      ownerCtx(callsOwner)
    );
    assert.strictEqual(secOwner.ok, true, 'owner dengan secret.view tetap bisa baca');
    assert.strictEqual(callsOwner[0].path, '/secrets');
  });

  test('REM2: list_audit_events ter-gate audit.view (viewer ditolak, operator lolos)', async () => {
    const callsDenied = [];
    const denied = await executeVmPanelTool(
      'list_audit_events',
      {},
      matrixCtx(callsDenied, 'viewer')
    );
    assert.strictEqual(denied.ok, false, 'audit.view bukan milik viewer (§11.2)');
    assert.strictEqual(denied.blocked, true);
    assert.strictEqual(callsDenied.length, 0, 'trail yang diblok tidak boleh menyentuh manager');

    const calls = [];
    const ok = await executeVmPanelTool('list_audit_events', {}, matrixCtx(calls, 'operator'));
    assert.strictEqual(ok.ok, true, 'operator dengan audit.view boleh baca trail');
    assert.strictEqual(calls[0].path, '/audit');

    const noCtx = await executeVmPanelTool('list_audit_events', {}, { managerClient: mockClient(callsDenied) });
    assert.strictEqual(noCtx.blocked, true, 'fail-closed tanpa konteks izin');
  });

  test('NIT: tool-spec query_manager_route GET-only (enum + tanpa param body)', () => {
    const spec = VM_PANEL_TOOLS.find((t) => t.function?.name === 'query_manager_route');
    assert.ok(spec, 'tool spec harus ada');
    assert.deepEqual(spec.function.parameters.properties.method.enum, ['GET']);
    assert.ok(
      !('body' in spec.function.parameters.properties),
      'parameter body tidak boleh ditawarkan pada channel baca',
    );
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

  test('collectHostMetrics returns valid cpu, memory, host', () => {
    const m = collectHostMetrics();
    assert.ok(m.cpu && m.cpu.cores >= 1);
    assert.ok(typeof m.cpu.model === 'string');
    assert.ok(m.memory && m.memory.totalMb > 0);
    assert.ok(m.memory.usedMb >= 0);
    assert.ok(m.host && m.host.platform);
  });

  test('detectSystemIntent correctly identifies queries', () => {
    assert.strictEqual(detectSystemIntent('Cek status CPU dan RAM'), 'status');
    assert.strictEqual(detectSystemIntent('Tampilkan list service yang aktif'), 'services');
    assert.strictEqual(detectSystemIntent('Periksa 9router port 20127'), '9router');
    assert.strictEqual(detectSystemIntent('Bagaimana panduan deploy project?'), 'deploy');
    assert.strictEqual(detectSystemIntent('update hermes agent agar menyesuaikan terus perubahan masa depan'), 'introspect');
    assert.strictEqual(detectSystemIntent('halo selamat pagi'), 'greet');
    assert.strictEqual(detectSystemIntent('siapa kamu dan apa profil identitas kamu?'), 'profile');
    assert.strictEqual(detectSystemIntent('tolong bantuan perintah'), 'help');
    assert.strictEqual(detectSystemIntent('apa kabar dunia'), 'general');
  });

  test('generateLocalAnswer generates expected replies for all intents', async () => {
    const introAns = await generateLocalAnswer('introspect', 'apa yang baru');
    assert.ok(introAns.includes('Kapabilitas Dinamis'));
    assert.ok(introAns.includes('[AUTO-DISCOVERED]'));

    const profAns = await generateLocalAnswer('profile', 'siapa kamu');
    assert.ok(profAns.includes('Profil'));
    assert.ok(profAns.includes('Kategori Operasional'));
    assert.ok(!profAns.includes('⚡'));

    const statusAns = await generateLocalAnswer('status', 'status');
    assert.ok(statusAns.includes('Status Sistem Host'));
    assert.ok(statusAns.includes('CPU'));
    assert.ok(statusAns.includes('RAM'));

    const servAns = await generateLocalAnswer('services', 'services', {
      managerGet: async () => [{ id: 'srv_1', name: 'app-web', type: 'node', port: 3000, status: 'running' }],
    });
    assert.ok(servAns.includes('app-web'));
    assert.ok(servAns.includes('3000'));

    const rAns = await generateLocalAnswer('9router', '9router');
    assert.ok(rAns.includes('9Router'));

    const depAns = await generateLocalAnswer('deploy', 'deploy');
    assert.ok(depAns.includes('Panduan Deploy'));

    const greetAns = await generateLocalAnswer('greet', 'halo');
    assert.ok(greetAns.includes('Hermes Agent'));
  });

  test('handleAssistantChat answers status query with real-time host metrics', async () => {
    const { Readable } = await import('node:stream');
    let resData = '';
    const fakeRes = {
      writeHead: (code) => { fakeRes.statusCode = code; },
      end: (str) => { resData = str; },
    };
    const req = Readable.from([JSON.stringify({ message: 'Cek penggunaan CPU dan RAM host sekarang' })]);

    await handleAssistantChat(req, fakeRes, { forceLocal: true });
    assert.strictEqual(fakeRes.statusCode, 200);
    const result = JSON.parse(resData);
    assert.ok(result.reply.includes('Status Sistem Host'));
    assert.ok(result.reply.includes('RAM'));
    assert.strictEqual(result.source, 'hermes-local');
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

  test('handleAssistantChat enforces global deadline when upstream stalls (A2#15)', async () => {
    const { Readable } = await import('node:stream');
    // Mock: health & katalog model responsif, chat/completions ditahan selamanya.
    // Hanya deadline global yang boleh membebaskan handler — lalu jatuh ke fallback lokal.
    const stalled = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stall-model' }] }));
        return;
      }
      // /v1/chat/completions: jangan pernah respons — biarkan deadline yang abort.
    });
    await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const prevBase = process.env.OPENAI_BASE_URL;
    const prevDeadline = process.env.HERMES_CHAT_DEADLINE_MS;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${stalled.address().port}/v1`;
    process.env.HERMES_CHAT_DEADLINE_MS = '1500';
    try {
      let resData = '';
      const fakeRes = {
        writeHead: (code) => { fakeRes.statusCode = code; },
        end: (str) => { resData = str; },
      };
      const req = Readable.from([JSON.stringify({ message: 'Halo Hermes' })]);
      const t0 = Date.now();
      await handleAssistantChat(req, fakeRes);
      const elapsed = Date.now() - t0;
      assert.strictEqual(fakeRes.statusCode, 200);
      const result = JSON.parse(resData);
      assert.strictEqual(result.source, 'hermes-local');
      assert.ok(elapsed < 8000, `deadline harus memicu fallback cepat, got ${elapsed}ms`);
    } finally {
      process.env.OPENAI_BASE_URL = prevBase;
      process.env.HERMES_CHAT_DEADLINE_MS = prevDeadline;
      if (typeof stalled.closeAllConnections === 'function') stalled.closeAllConnections();
      await new Promise((resolve) => stalled.close(resolve));
    }
  });
});

describe('PanelServer /api/assistant endpoints', () => {
  let sandboxDir;
  let panelServer;
  let panelPort;
  let sessionCookie = '';
  let csrfToken = ''; // A2#8: rute chat kini wajib CSRF double-submit

  const chatHeaders = () => ({
    Cookie: `${sessionCookie}; vpanel_csrf=${csrfToken}`,
    'Content-Type': 'application/json',
    'x-csrf-token': csrfToken,
  });

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
      if (c.includes('vpanel_csrf=')) {
        csrfToken = c.split(';')[0].split('=').slice(1).join('=');
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
      headers: chatHeaders(),
      body: JSON.stringify({ message: 'Halo Hermes' }),
      redirect: 'manual',
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.reply);
  });

  test('detectDeployIntent correctly parses deployment instructions', () => {
    // 1. Port change
    const p1 = detectDeployIntent('ganti port ke 3005');
    assert.strictEqual(p1?.type, 'set_port');
    assert.strictEqual(p1?.port, 3005);
    assert.strictEqual(p1?.action?.updates?.port, 3005);

    // 2. Env token set
    const e1 = detectDeployIntent('set BOT_TOKEN=123456789:ABCDEF');
    assert.strictEqual(e1?.type, 'set_env');
    assert.strictEqual(e1?.key, 'BOT_TOKEN');
    assert.strictEqual(e1?.value, '123456789:ABCDEF');
    assert.strictEqual(e1?.action?.updates?.env?.BOT_TOKEN, '123456789:ABCDEF');

    // 2b. 9Router Combo / Model configuration
    const c1 = detectDeployIntent('gunakan combos bernama "Hermes-Tele" di 9router untuk configurasi hermes bot ini');
    assert.strictEqual(c1?.type, 'set_combo');
    assert.strictEqual(c1?.combo, 'Hermes-Tele');
    assert.strictEqual(c1?.action?.updates?.env?.OPENAI_MODEL, 'Hermes-Tele');
    assert.strictEqual(c1?.action?.updates?.env?.OPENAI_BASE_URL, 'http://127.0.0.1:20127/v1');

    // 3. Project name change
    const n1 = detectDeployIntent('nama project my-super-bot');
    assert.strictEqual(n1?.type, 'set_name');
    assert.strictEqual(n1?.name, 'my-super-bot');
    assert.strictEqual(n1?.action?.updates?.name, 'my-super-bot');

    // 4. Trigger deploy
    const d1 = detectDeployIntent('deploy sekarang');
    assert.strictEqual(d1?.type, 'trigger_deploy');
    assert.strictEqual(d1?.action?.type, 'trigger_deploy');

    // 5. Code analysis query with deploy context
    const a1 = detectDeployIntent('analisis kelengkapan arsitektur', {
      framework: 'Telegraf (Telegram Bot)',
      entryFile: 'index.js',
      port: 10002,
      detectedEnvs: [{ key: 'BOT_TOKEN', required: true }],
      env: {},
    });
    assert.strictEqual(a1?.type, 'analysis_report');
    assert.ok(a1?.reply.includes('Telegraf'));
    assert.ok(a1?.reply.includes('BOT_TOKEN'));
    // 6. Informational questions must NOT be intercepted as execution triggers
    assert.strictEqual(detectDeployIntent('cara deploy project?'), null);
    assert.strictEqual(detectDeployIntent('Tolong jelaskan cara mendeploy project baru di VM-Panel.'), null);
    assert.strictEqual(detectDeployIntent('bagaimana panduan deploy project?'), null);
  });

  test('POST /api/assistant/chat answers informational deploy questions without triggering deploy action', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({
        message: 'Tolong jelaskan cara mendeploy project baru di VM-Panel.',
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.reply);
    assert.notStrictEqual(data.source, 'hermes-copilot');
    assert.strictEqual(data.action, undefined);
    assert.ok(data.reply.includes('Panduan') || data.reply.includes('deploy') || data.reply.includes('Project'));
  });

  test('POST /api/assistant/chat processes deployContext commands and returns reactive action', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({
        message: 'set BOT_TOKEN=secret_token_123',
        deployContext: {
          folderPath: 'C:\\test',
          projectName: 'test-app',
          port: 10001,
        },
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.reply);
    assert.strictEqual(data.source, 'hermes-copilot');
    assert.strictEqual(data.action?.updates?.env?.BOT_TOKEN, 'secret_token_123');
  });

  test('POST /api/assistant/chat returns project analysis as hermes-copilot without leaking host SRE report', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({
        message: 'analisis kelengkapan arsitektur',
        deployContext: {
          folderPath: 'C:\\Projects\\Hermes-Telegram',
          projectName: 'Hermes-Telegram',
          framework: 'Aiogram (Telegram Bot)',
          entryFile: 'bot.py',
          port: 10005,
          detectedEnvs: [{ key: 'BOT_TOKEN', required: true }],
          env: {},
        },
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.reply);
    assert.strictEqual(data.source, 'hermes-copilot');
    assert.ok(data.reply.includes('Aiogram') || data.reply.includes('bot.py') || data.reply.includes('BOT_TOKEN'));
    // Ensure it did NOT leak the host VM-Panel SRE report
    assert.ok(!data.reply.includes('VM-Panel v0.1.0'));
  });

  // A2#8/#26 — validasi rute chat: CSRF wajib, message & history limit, body 1MB.
  test('POST /api/assistant/chat rejects missing CSRF token with 403 JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: {
        Cookie: `${sessionCookie}; vpanel_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Halo' }),
    });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('POST /api/assistant/chat rejects message over 4000 chars with 400', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({ message: 'a'.repeat(4001) }),
    });
    assert.strictEqual(res.status, 400);
  });

  test('POST /api/assistant/chat rejects invalid history (role/length) with 400', async () => {
    const badRole = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({ message: 'Halo', history: [{ role: 'system', content: 'x' }] }),
    });
    assert.strictEqual(badRole.status, 400);
    const tooMany = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({
        message: 'Halo',
        history: Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })),
      }),
    });
    assert.strictEqual(tooMany.status, 400);
  });

  test('POST /api/assistant/chat rejects body over 1MB with 413 (no hang)', async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/chat`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({ message: 'a'.repeat(1024 * 1024 + 32) }),
    });
    assert.strictEqual(res.status, 413);
  });
});

