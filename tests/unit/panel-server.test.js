// tests/unit/panel-server.test.js — unit test panel/server/index.js (DESIGN §16/§17).
// ManagerClient di-mock (inject), templates via fixture tmp (templatesDir),
// static via fixture tmp (staticDir) — panel/templates & panel/static tak disentuh.
// Kasus: /login 200; POST login → Set-Cookie HttpOnly + redirect /; tanpa
// session → redirect /login; dengan session → 200 render; rate limit login
// 11x → 429; static served + traversal ditolak; viewer POST → 403; manager
// down → halaman 200 dengan banner.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelServer } from '../../panel/server/index.js';
import { totpGenerate } from '../../lib/crypto.js';
import { VmPanelError } from '../../lib/errors.js';

// --- helper HTTP -------------------------------------------------------------

function request(port, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function form(fields) {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(Buffer.byteLength(fields)),
  };
}

function postForm(port, path, fields, extraHeaders = {}) {
  const body = new URLSearchParams(fields).toString();
  return request(port, 'POST', path, { headers: { ...form(body), ...extraHeaders }, body });
}

function cookieValue(setCookie, name) {
  for (const c of setCookie ?? []) {
    const m = String(c).match(new RegExp(`^${name}=([^;]*)`));
    if (m) return m[1];
  }
  return null;
}

// --- fixtures -----------------------------------------------------------------

const TEMPLATE_VARS = {
  login: 'LOGIN_PAGE error={{error}} user={{username}}',
  dashboard: 'DASHBOARD user={{username}} role={{role}} banner={{banner}} status={{managerStatus}} projects={{projectCount}}',
  projects: 'PROJECTS banner={{banner}} rows={{rowsJson}}',
  project_detail: 'PROJECT_DETAIL id={{itemId}} found={{found}} banner={{banner}} note={{note}}',
  services: 'SERVICES note={{note}}',
  deployments: 'DEPLOYMENTS note={{note}}',
  health: 'HEALTH banner={{banner}} state={{managerHealth}}',
  recovery: 'RECOVERY note={{note}}',
  backups: 'BACKUPS note={{note}}',
  audit: 'AUDIT banner={{banner}} total={{total}} rows={{rowsJson}}',
  users: 'USERS rows={{rowsJson}}',
  settings: 'SETTINGS note={{note}}',
  logs: 'LOGS note={{note}}',
  error: 'ERROR_PAGE code={{code}} message={{message}}',
};

function makeFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'vpanel-fix-'));
  const templates = join(root, 'templates');
  const staticDir = join(root, 'static');
  mkdirSync(templates, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  for (const [name, content] of Object.entries(TEMPLATE_VARS)) {
    writeFileSync(join(templates, `${name}.html`), content);
  }
  writeFileSync(join(staticDir, 'style.css'), '.x { color: red; }');
  // file DI LUAR static dir — target uji traversal (harus ditolak)
  writeFileSync(join(root, 'secret.txt'), 'TOPSECRET');
  return { root, templates, staticDir };
}

const OK_MANAGER = {
  systemStatus: async () => ({ status: 'running', pid: 42 }),
  systemInfo: async () => ({ name: 'vm', version: '0.1.0' }),
  health: async () => ({ ok: true }),
  listProjects: async () => [{ id: 'prj_DEMO1234', name: 'demo', status: 'running' }],
  listAudit: async () => ({ rows: [{ id: 1, operation: 'LOGIN_SUCCESS', actor: 'admin' }], total: 1 }),
};

const DEFAULT_CONFIG = {
  panel: { port: 0, sessionTtlMin: 480, ratePerMin: 60, loginRatePerMin: 10 },
  manager: { apiPort: 8097 },
};

function makeServer({ managerClient = OK_MANAGER, config = DEFAULT_CONFIG } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'vpanel-srv-'));
  const fixtures = makeFixtures();
  const server = new PanelServer({
    rootDir: join(dataDir, 'root'),
    dataDir,
    templatesDir: fixtures.templates,
    staticDir: fixtures.staticDir,
    managerClient,
    config,
  });
  const boot = server.auth.bootstrapOwner({ username: 'admin', password: 'password123' });
  return {
    server,
    boot,
    fixtures,
    dataDir,
    close: async () => {
      await server.close();
      rmSync(fixtures.root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// --- suite utama ----------------------------------------------------------------

describe('PanelServer', () => {
  const ctx = {};

  before(async () => {
    ctx.s = makeServer();
    await ctx.s.server.start();
    ctx.port = ctx.s.server.port;
  });

  after(async () => {
    await ctx.s.close();
  });

  test('GET /login → 200 render (publik)', async () => {
    const r = await request(ctx.port, 'GET', '/login');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('LOGIN_PAGE'));
    assert.ok(r.headers['content-type'].includes('text/html'));
  });

  test('POST /login sukses → 302 /, Set-Cookie HttpOnly + csrf cookie', async () => {
    const code = totpGenerate(ctx.s.boot.totpSecretBase32);
    const r = await postForm(ctx.port, '/login', {
      username: 'admin',
      password: 'password123',
      totpCode: code,
    });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/');
    const cookies = r.headers['set-cookie'];
    const sid = cookieValue(cookies, 'vpanel_session');
    const csrf = cookieValue(cookies, 'vpanel_csrf');
    assert.match(sid, /^[0-9a-f]{64}$/);
    assert.match(csrf, /^[0-9a-f]{64}$/);
    const sessionCookie = cookies.find((c) => c.startsWith('vpanel_session='));
    assert.ok(sessionCookie.includes('HttpOnly'), 'session cookie HttpOnly');
    assert.ok(sessionCookie.includes('SameSite=Strict'));
    const csrfCookie = cookies.find((c) => c.startsWith('vpanel_csrf='));
    assert.ok(!csrfCookie.includes('HttpOnly'), 'csrf cookie bukan HttpOnly');
    ctx.admin = { sid, csrf };
  });

  test('POST /login password salah → 401 render login (bukan crash)', async () => {
    const r = await postForm(ctx.port, '/login', { username: 'admin', password: 'salah-banget' });
    assert.equal(r.status, 401);
    assert.ok(r.body.includes('LOGIN_PAGE'));
    assert.ok(r.body.includes('Username atau password salah'));
  });

  test('GET / tanpa session → redirect /login', async () => {
    const r = await request(ctx.port, 'GET', '/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/login');
  });

  test('GET /projects tanpa session → redirect /login', async () => {
    const r = await request(ctx.port, 'GET', '/projects');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/login');
  });

  test('GET / dengan session → 200 render dashboard + data manager mock', async () => {
    const r = await request(ctx.port, 'GET', '/', {
      headers: { cookie: `vpanel_session=${ctx.admin.sid}; vpanel_csrf=${ctx.admin.csrf}` },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('DASHBOARD'));
    assert.ok(r.body.includes('user=admin'));
    assert.ok(r.body.includes('projects=1'));
    assert.ok(!r.body.includes('Manager tidak terjangkau'));
  });

  test('GET /projects + detail /projects/:id → 200', async () => {
    const h = { cookie: `vpanel_session=${ctx.admin.sid}; vpanel_csrf=${ctx.admin.csrf}` };
    const r1 = await request(ctx.port, 'GET', '/projects', { headers: h });
    assert.equal(r1.status, 200);
    assert.ok(r1.body.includes('demo'));
    const r2 = await request(ctx.port, 'GET', '/projects/prj_DEMO1234', { headers: h });
    assert.equal(r2.status, 200);
    assert.ok(r2.body.includes('PROJECT_DETAIL'));
    assert.ok(r2.body.includes('id=prj_DEMO1234'));
    assert.ok(r2.body.includes('found=yes'));
  });

  test('GET /audit → 200 rows dari manager; GET /services → 200 note F5', async () => {
    const h = { cookie: `vpanel_session=${ctx.admin.sid}; vpanel_csrf=${ctx.admin.csrf}` };
    const r1 = await request(ctx.port, 'GET', '/audit', { headers: h });
    assert.equal(r1.status, 200);
    assert.ok(r1.body.includes('LOGIN_SUCCESS'));
    const r2 = await request(ctx.port, 'GET', '/services', { headers: h });
    assert.equal(r2.status, 200);
    assert.ok(r2.body.includes('endpoint belum tersedia (F5)'));
  });

  test('static: css served; extension asing & missing → 404; traversal → 403', async () => {
    const ok = await request(ctx.port, 'GET', '/assets/style.css');
    assert.equal(ok.status, 200);
    assert.ok(ok.headers['content-type'].includes('text/css'));
    assert.equal(ok.headers['cache-control'], 'no-cache');
    assert.ok(ok.body.includes('color: red'));

    const badExt = await request(ctx.port, 'GET', '/assets/secret.txt');
    assert.equal(badExt.status, 404);
    const missing = await request(ctx.port, 'GET', '/assets/tidakada.css');
    assert.equal(missing.status, 404);

    // traversal encoded (%2e%2e = ..) — path raw via http.request
    const trav = await request(ctx.port, 'GET', '/assets/%2e%2e/secret.txt');
    assert.ok(trav.status === 403 || trav.status === 404, `traversal ditolak (${trav.status})`);
    assert.ok(trav.status === 403);
    assert.ok(!trav.body.includes('TOPSECRET'));
    const trav2 = await request(ctx.port, 'GET', '/assets/..%2fsecret.txt');
    assert.ok(trav2.status === 403 || trav2.status === 404);
    assert.ok(!trav2.body.includes('TOPSECRET'));
  });

  test('GET /users oleh admin → 200 (owner); viewer GET /users → 403', async () => {
    const h = { cookie: `vpanel_session=${ctx.admin.sid}; vpanel_csrf=${ctx.admin.csrf}` };
    const r = await request(ctx.port, 'GET', '/users', { headers: h });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('USERS'));

    // buat viewer: inactive → approve → password + recovery codes
    const perm = ctx.s.server.auth.perm;
    const created = perm.createUser({ username: 'vic', role: 'viewer' });
    perm.approveUser(created.userId, perm.getUserByUsername('admin').userId);
    ctx.s.server.auth.setPassword('vic', 'viewerpass1');
    const codes = ctx.s.server.auth.issueRecoveryCodes('vic');

    const vLogin = await postForm(ctx.port, '/login', {
      username: 'vic',
      password: 'viewerpass1',
      recoveryCode: codes[0],
    });
    assert.equal(vLogin.status, 302);
    ctx.viewer = {
      sid: cookieValue(vLogin.headers['set-cookie'], 'vpanel_session'),
      csrf: cookieValue(vLogin.headers['set-cookie'], 'vpanel_csrf'),
    };

    const vh = { cookie: `vpanel_session=${ctx.viewer.sid}; vpanel_csrf=${ctx.viewer.csrf}` };
    const r2 = await request(ctx.port, 'GET', '/users', { headers: vh });
    assert.equal(r2.status, 403);
    assert.ok(r2.body.includes('PERMISSION_DENIED'));

    // viewer GET /audit juga ditolak (audit.view: owner+operator saja)
    const r3 = await request(ctx.port, 'GET', '/audit', { headers: vh });
    assert.equal(r3.status, 403);
    // viewer GET / (project.view) diizinkan
    const r4 = await request(ctx.port, 'GET', '/', { headers: vh });
    assert.equal(r4.status, 200);
  });

  test('viewer POST /users dengan CSRF valid → 403 PERMISSION_DENIED (user.manage)', async () => {
    const r = await postForm(
      ctx.port,
      '/users',
      { action: 'create-user', username: 'hacker', role: 'owner' },
      {
        cookie: `vpanel_session=${ctx.viewer.sid}; vpanel_csrf=${ctx.viewer.csrf}`,
        'x-csrf-token': ctx.viewer.csrf,
      },
    );
    assert.equal(r.status, 403);
    assert.ok(r.body.includes('ERROR_PAGE'));
    assert.ok(r.body.includes('PERMISSION_DENIED'));
    // target tidak terlanjur dibuat
    assert.equal(ctx.s.server.auth.perm.getUserByUsername('hacker'), null);
  });

  test('POST /users tanpa CSRF header → 403 (double-submit ditolak)', async () => {
    const r = await postForm(
      ctx.port,
      '/users',
      { action: 'create-user', username: 'baru', role: 'viewer' },
      { cookie: `vpanel_session=${ctx.admin.sid}; vpanel_csrf=${ctx.admin.csrf}` },
    );
    assert.equal(r.status, 403);
    assert.ok(r.body.includes('PERMISSION_DENIED'));
    assert.equal(ctx.s.server.auth.perm.getUserByUsername('baru'), null);
  });

  test('admin POST /users dengan CSRF valid → create + approve + set-role sukses', async () => {
    const h = {
      cookie: `vpanel_session=${ctx.admin.sid}; vpanel_csrf=${ctx.admin.csrf}`,
      'x-csrf-token': ctx.admin.csrf,
    };
    const r1 = await postForm(ctx.port, '/users', { action: 'create-user', username: 'dana', role: 'operator' }, h);
    assert.equal(r1.status, 302);
    assert.equal(ctx.s.server.auth.perm.getUserByUsername('dana').status, 'inactive');

    const r2 = await postForm(ctx.port, '/users', { action: 'approve-user', username: 'dana' }, h);
    assert.equal(r2.status, 302);
    assert.equal(ctx.s.server.auth.perm.getUserByUsername('dana').status, 'active');

    const r3 = await postForm(ctx.port, '/users', { action: 'set-role', username: 'dana', role: 'viewer' }, h);
    assert.equal(r3.status, 302);
    assert.equal(ctx.s.server.auth.perm.getUserByUsername('dana').role, 'viewer');

    const r4 = await postForm(ctx.port, '/users', { action: 'aksi-aneh', username: 'x' }, h);
    assert.equal(r4.status, 400);
  });

  test('POST /logout dengan CSRF → 302 /login; session lama mati', async () => {
    const r = await postForm(
      ctx.port,
      '/logout',
      {},
      { cookie: `vpanel_session=${ctx.viewer.sid}; vpanel_csrf=${ctx.viewer.csrf}`, 'x-csrf-token': ctx.viewer.csrf },
    );
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/login');
    const after = await request(ctx.port, 'GET', '/', {
      headers: { cookie: `vpanel_session=${ctx.viewer.sid}` },
    });
    assert.equal(after.status, 302);
    assert.equal(after.headers.location, '/login');
  });

  test('GET /tidakada → 404 error page (tanpa stack)', async () => {
    const r = await request(ctx.port, 'GET', '/tidakada', {
      headers: { cookie: `vpanel_session=${ctx.admin.sid}` },
    });
    assert.equal(r.status, 404);
    assert.ok(r.body.includes('ERROR_PAGE'));
    assert.ok(!r.body.includes('at '), 'tanpa stack trace');
  });
});

describe('PanelServer: rate limit login', () => {
  const ctx = {};

  before(async () => {
    ctx.s = makeServer(); // loginRatePerMin default 10
    await ctx.s.server.start();
    ctx.port = ctx.s.server.port;
  });

  after(async () => {
    await ctx.s.close();
  });

  test('POST /login 11x dari IP sama → request ke-11 = 429', async () => {
    const statuses = [];
    const bodies = [];
    for (let i = 0; i < 11; i++) {
      const r = await postForm(ctx.port, '/login', { username: 'admin', password: `wrong-${i}` });
      statuses.push(r.status);
      bodies.push(r.body);
    }
    // 1-5: 401 invalid; 6-10: 429 locked; 11: 429 rate limit
    assert.equal(statuses[0], 401);
    assert.equal(statuses[4], 401);
    for (let i = 10; i < 11; i++) {
      assert.equal(statuses[i], 429, `req #${i + 1}`);
    }
    // request ke-11 adalah rate limit (bukan lockout) — pesan berbeda
    assert.ok(bodies[10].includes('Terlalu banyak percobaan login'));
    // dan pasti sudah terkunci sejak request ke-6
    assert.ok(bodies[5].includes('terkunci') || bodies[5].includes('Terlalu banyak'));
  });
});

describe('PanelServer: manager down → graceful', () => {
  const ctx = {};

  before(async () => {
    const down = {
      systemStatus: async () => {
        throw new VmPanelError('UNREACHABLE', 'cannot reach manager');
      },
      systemInfo: async () => {
        throw new VmPanelError('UNREACHABLE', 'cannot reach manager');
      },
      health: async () => {
        throw new VmPanelError('UNREACHABLE', 'cannot reach manager');
      },
      listProjects: async () => {
        throw new VmPanelError('UNREACHABLE', 'cannot reach manager');
      },
      listAudit: async () => {
        throw new VmPanelError('UNREACHABLE', 'cannot reach manager');
      },
    };
    ctx.s = makeServer({ managerClient: down });
    await ctx.s.server.start();
    ctx.port = ctx.s.server.port;
    // session admin via recovery code (tanpa manager sama sekali)
    const codes = ctx.s.server.auth.issueRecoveryCodes('admin');
    const r = await postForm(ctx.port, '/login', {
      username: 'admin',
      password: 'password123',
      recoveryCode: codes[0],
    });
    assert.equal(r.status, 302);
    ctx.sid = cookieValue(r.headers['set-cookie'], 'vpanel_session');
    ctx.csrf = cookieValue(r.headers['set-cookie'], 'vpanel_csrf');
  });

  after(async () => {
    await ctx.s.close();
  });

  test('GET / → 200 + banner "Manager tidak terjangkau" + empty state', async () => {
    const r = await request(ctx.port, 'GET', '/', {
      headers: { cookie: `vpanel_session=${ctx.sid}` },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('DASHBOARD'));
    assert.ok(r.body.includes('Manager tidak terjangkau'));
    assert.ok(r.body.includes('projects=0'));
  });

  test('GET /audit → 200 + banner (tetap render, tidak crash)', async () => {
    const r = await request(ctx.port, 'GET', '/audit', {
      headers: { cookie: `vpanel_session=${ctx.sid}` },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('AUDIT'));
    assert.ok(r.body.includes('Manager tidak terjangkau'));
  });

  test('GET /health → 200 + banner unreachable', async () => {
    const r = await request(ctx.port, 'GET', '/health', {
      headers: { cookie: `vpanel_session=${ctx.sid}` },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('Manager tidak terjangkau'));
  });
});
