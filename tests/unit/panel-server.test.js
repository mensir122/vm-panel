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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // FX-2 BUG 1: dummy PNG 1x1 — logo yang direferensikan template
  // (oriont-logo.png) diuji lewat fixture staticDir, pola sama dgn style.css.
  writeFileSync(
    join(staticDir, 'oriont-logo.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
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

  test('POST /login localhost bypass: tanpa TOTP/recovery → 302 sukses', async () => {
    // Koneksi dari 127.0.0.1 (localhost) — 2FA wajib di-bypass
    const r = await postForm(ctx.port, '/login', {
      username: 'admin',
      password: 'password123',
      // TANPA totpCode, TANPA recoveryCode
    });
    assert.equal(r.status, 302, 'localhost login tanpa 2FA harus sukses');
    assert.equal(r.headers.location, '/');
    const sid = cookieValue(r.headers['set-cookie'], 'vpanel_session');
    assert.ok(sid, 'session cookie harus ada');
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

  test('A2#3 logout via BODY-FORM (_csrf tanpa header) → 302 + cookie dihapus', async () => {
    // viewer baru untuk jalur form native (tanpa header x-csrf-token)
    const perm = ctx.s.server.auth.perm;
    const created = perm.createUser({ username: 'lina', role: 'viewer' });
    perm.approveUser(created.userId, perm.getUserByUsername('admin').userId);
    ctx.s.server.auth.setPassword('lina', 'linapass123');
    const codes = ctx.s.server.auth.issueRecoveryCodes('lina');
    const vLogin = await postForm(ctx.port, '/login', {
      username: 'lina',
      password: 'linapass123',
      recoveryCode: codes[0],
    });
    assert.equal(vLogin.status, 302);
    const lina = {
      sid: cookieValue(vLogin.headers['set-cookie'], 'vpanel_session'),
      csrf: cookieValue(vLogin.headers['set-cookie'], 'vpanel_csrf'),
    };

    // POST /logout HANYA dengan field _csrf di body (persis submit form HTML)
    const r = await postForm(
      ctx.port,
      '/logout',
      { _csrf: lina.csrf },
      { cookie: `vpanel_session=${lina.sid}; vpanel_csrf=${lina.csrf}` },
    );
    assert.equal(r.status, 302, 'form POST logout harus lolos CSRF lewat body');
    assert.equal(r.headers.location, '/login');
    const cleared = (r.headers['set-cookie'] ?? []).filter(
      (c) => /vpanel_(session|csrf)=;/.test(String(c)) && /Max-Age=0/.test(String(c)),
    );
    assert.equal(cleared.length, 2, 'session + csrf cookie dihapus (Max-Age=0)');
    const after = await request(ctx.port, 'GET', '/', { headers: { cookie: `vpanel_session=${lina.sid}` } });
    assert.equal(after.status, 302, 'session lama mati');
  });

  test('A2#3 semua template logout form punya hidden _csrf (dan login/error tidak punya tag menggantung)', async () => {
    const { readdirSync, readFileSync: rf } = await import('node:fs');
    const dir = new URL('../../panel/templates/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const names = readdirSync(dir).filter((n) => n.endsWith('.html'));
    let logoutWithCsrf = 0;
    for (const n of names) {
      const html = rf(join(dir, n), 'utf8');
      if (html.includes('action="/logout"')) {
        logoutWithCsrf += 1;
        assert.ok(
          html.includes('<input type="hidden" name="_csrf" value="{{csrfToken}}">'),
          `${n}: form logout wajib punya hidden _csrf`,
        );
      }
    }
    assert.ok(logoutWithCsrf >= 12, `minimal 12 template logout (dapat ${logoutWithCsrf})`);
    // Guard aturan AGENTS.md: jangan ada tag tak-terisi — login/error tidak
    // dirender via #pageVars sehingga TIDAK boleh memuat {{csrfToken}}.
    for (const n of ['login.html', 'error.html']) {
      const html = rf(join(dir, n), 'utf8');
      assert.ok(!html.includes('{{csrfToken}}'), `${n}: tidak boleh ada tag csrfToken tak terpenuhi`);
    }
  });

  test('A2#14/A2#2 viewer POST /api/desktop/deploy-folder → 403 permission (sebelum baca folder)', async () => {
    // viewer 'lina' sudah logout di test sebelumnya; buat sesi viewer lagi via dana? pakai vic? — vic juga logout.
    // Buat viewer baru 'dev2' cukup untuk assert permission.
    const perm = ctx.s.server.auth.perm;
    const created = perm.createUser({ username: 'dev2', role: 'viewer' });
    perm.approveUser(created.userId, perm.getUserByUsername('admin').userId);
    ctx.s.server.auth.setPassword('dev2', 'dev2pass123');
    const codes = ctx.s.server.auth.issueRecoveryCodes('dev2');
    const vLogin = await postForm(ctx.port, '/login', {
      username: 'dev2',
      password: 'dev2pass123',
      recoveryCode: codes[0],
    });
    const vsid = cookieValue(vLogin.headers['set-cookie'], 'vpanel_session');
    const vcsrf = cookieValue(vLogin.headers['set-cookie'], 'vpanel_csrf');
    const r = await request(ctx.port, 'POST', '/api/desktop/deploy-folder', {
      headers: {
        cookie: `vpanel_session=${vsid}; vpanel_csrf=${vcsrf}`,
        'x-csrf-token': vcsrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folderPath: 'C:\\fake' }),
    });
    assert.equal(r.status, 403);
    assert.ok(r.body.includes('PERMISSION_DENIED'), 'viewer tanpa project.create ditolak');
  });

  test('A2#10 ?session= query tidak lagi mengautentikasi (harus cookie)', async () => {
    const r = await request(ctx.port, 'GET', `/?session=${ctx.admin.sid}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/login', 'tanpa cookie → tetap redirect login');
  });

  test('A2#21 static ETag + If-None-Match → 304 tanpa body', async () => {
    const r1 = await request(ctx.port, 'GET', '/assets/style.css');
    assert.equal(r1.status, 200);
    const etag = r1.headers.etag;
    assert.ok(typeof etag === 'string' && etag.startsWith('W/"'), `ETag ada (${etag})`);
    const r2 = await request(ctx.port, 'GET', '/assets/style.css', {
      headers: { 'if-none-match': etag },
    });
    assert.equal(r2.status, 304);
    assert.equal(r2.body, '', '304 tanpa body');
    const r3 = await request(ctx.port, 'GET', '/assets/style.css', {
      headers: { 'if-none-match': 'W/"bogus-etag"' },
    });
    assert.equal(r3.status, 200, 'ETag tak cocok → 200 normal');
  });

  test('GET /tidakada → 404 error page (tanpa stack)', async () => {
    const r = await request(ctx.port, 'GET', '/tidakada', {
      headers: { cookie: `vpanel_session=${ctx.admin.sid}` },
    });
    assert.equal(r.status, 404);
    assert.ok(r.body.includes('ERROR_PAGE'));
    assert.ok(!r.body.includes('at '), 'tanpa stack trace');
  });

  test('FX-3: GET /favicon.ico tanpa cookie → 200 image/svg+xml (motif oriont) + 304 ETag', async () => {
    // TANPA header cookie sama sekali — browser minta favicon juga pra-login.
    const r = await request(ctx.port, 'GET', '/favicon.ico');
    assert.equal(r.status, 200, 'favicon harus 200 tanpa session (rute publik)');
    assert.ok(r.headers['content-type'].includes('image/svg+xml'), `content-type (${r.headers['content-type']})`);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.ok(r.body.includes("<svg xmlns='http://www.w3.org/2000/svg'"), `body SVG (${r.body.slice(0, 60)})`);
    assert.ok(r.body.includes("circle cx='16' cy='16' r='9'"), 'motif lingkaran oriont (bukan chevron lama)');
    const etag = r.headers.etag;
    assert.ok(typeof etag === 'string' && etag.startsWith('W/"'), `ETag mini ada (${etag})`);
    const r2 = await request(ctx.port, 'GET', '/favicon.ico', { headers: { 'if-none-match': etag } });
    assert.equal(r2.status, 304, 'revalidasi If-None-Match → 304 tanpa body');
    assert.equal(r2.body, '');
  });

  test('FX-3: FAVICON_SVG brand sync — tidak lagi memuat biru GitHub 58a6ff', async () => {
    const r = await request(ctx.port, 'GET', '/favicon.ico');
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes('58a6ff'), 'stroke biru GitHub hilang dari favicon');
    assert.ok(r.body.includes("fill='#0A0D0C'"), 'kanvas obsidian kanonik (%230A0D0C ter-decode)');
    assert.ok(r.body.includes("stroke='#FFFFFF'"), 'stroke putih monokrom ORIONT');
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

describe('PanelServer: static png MIME + rate bucket static terpisah (FX-2)', () => {
  const ctx = {};

  before(async () => {
    ctx.s = makeServer(); // instance BARU → bucket bersih; ratePerMin 60, static default 600
    await ctx.s.server.start();
    ctx.port = ctx.s.server.port;
  });

  after(async () => {
    await ctx.s.close();
  });

  test('BUG1: GET /static/oriont-logo.png → 200 image/png (bukan 404)', async () => {
    const r = await request(ctx.port, 'GET', '/static/oriont-logo.png');
    assert.equal(r.status, 200, 'logo png harus disajikan (STATIC_TYPES .png)');
    assert.ok(r.headers['content-type'].includes('image/png'), `content-type (${r.headers['content-type']})`);
    // alias /assets/ juga harus dapat MIME yang sama
    const a = await request(ctx.port, 'GET', '/assets/oriont-logo.png');
    assert.equal(a.status, 200);
    assert.ok(a.headers['content-type'].includes('image/png'));
  });

  test('BUG1: extension unknown tetap 404 (bukan dibuka mentah-mentah)', async () => {
    const r = await request(ctx.port, 'GET', '/static/tidakada.webp');
    assert.equal(r.status, 404);
  });

  test('BUG2: 70 GET /static/style.css beruntun → SEMUA 200/304 (bukan 429)', async () => {
    for (let i = 0; i < 70; i++) {
      const r = await request(ctx.port, 'GET', '/static/style.css');
      assert.ok(r.status === 200 || r.status === 304, `static req #${i + 1} → ${r.status} (harus 200/304)`);
    }
  });

  test('BUG2: 70 GET /login beruntun → #61+ kena 429 (bucket halaman 60/menit utuh)', async () => {
    const statuses = [];
    for (let i = 0; i < 70; i++) {
      const r = await request(ctx.port, 'GET', '/login');
      statuses.push(r.status);
    }
    for (let i = 0; i < 60; i++) {
      assert.equal(statuses[i], 200, `login req #${i + 1} masih dalam limit 60`);
    }
    for (let i = 60; i < 70; i++) {
      assert.equal(statuses[i], 429, `login req #${i + 1} harus 429 (bucket global halaman utuh)`);
    }
  });

  test('BUG2: setelah halaman di-throttle, static MASIH 200 (bucket tidak saling makan)', async () => {
    const r = await request(ctx.port, 'GET', '/login');
    assert.equal(r.status, 429, 'bucket halaman masih penuh (sanity)');
    const s = await request(ctx.port, 'GET', '/static/style.css');
    assert.equal(s.status, 200, 'bucket static terpisah → tidak terpengaruh throttle halaman');
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

// --- A2#13: destruktif dua-fase sisi server -----------------------------------

describe('PanelServer: delete project dua-fase server-side (A2#13)', () => {
  const ctx = {};

  before(async () => {
    ctx.calls = [];
    const client = {
      ...OK_MANAGER,
      request: async (method, path) => {
        ctx.calls.push(`${method} ${path}`);
        return { ok: true };
      },
    };
    ctx.s = makeServer({ managerClient: client });
    await ctx.s.server.start();
    ctx.port = ctx.s.server.port;
    const codes = ctx.s.server.auth.issueRecoveryCodes('admin');
    const r = await postForm(ctx.port, '/login', {
      username: 'admin',
      password: 'password123',
      recoveryCode: codes[0],
    });
    ctx.sid = cookieValue(r.headers['set-cookie'], 'vpanel_session');
    ctx.csrf = cookieValue(r.headers['set-cookie'], 'vpanel_csrf');
    ctx.h = () => ({ cookie: `vpanel_session=${ctx.sid}; vpanel_csrf=${ctx.csrf}`, 'x-csrf-token': ctx.csrf });
  });

  after(async () => {
    await ctx.s.close();
  });

  test('fase 1 tanpa token → halaman konfirmasi (200), manager TIDAK disentuh', async () => {
    const r = await postForm(ctx.port, '/projects/prj_DEL1/delete', {}, ctx.h());
    assert.equal(r.status, 200, 'fase 1 = halaman konfirmasi, bukan delete langsung');
    const m = r.body.match(/name="confirmToken" value="([0-9a-f]+)"/);
    assert.ok(m, 'token konfirmasi ada di halaman');
    assert.ok(r.body.includes('name="_csrf"'), 'form konfirmasi membawa CSRF');
    assert.ok(
      !ctx.calls.some((c) => c.startsWith('DELETE')),
      `fase 1 tidak memanggil manager DELETE (calls=${JSON.stringify(ctx.calls)})`,
    );
    ctx.tok = m[1];
  });

  test('fase 2 token salah → 403; token benar → 302 + DELETE manager; reuse → 403 (sekali pakai)', async () => {
    const bad = await postForm(
      ctx.port,
      '/projects/prj_DEL1/delete',
      { confirmToken: 'a'.repeat(64) },
      ctx.h(),
    );
    assert.equal(bad.status, 403);
    assert.ok(bad.body.includes('PERMISSION_DENIED'));
    assert.ok(!ctx.calls.some((c) => c.startsWith('DELETE')), 'token salah tidak mengeksekusi');

    const ok = await postForm(
      ctx.port,
      '/projects/prj_DEL1/delete',
      { confirmToken: ctx.tok },
      ctx.h(),
    );
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, '/projects');
    assert.ok(ctx.calls.includes('DELETE /projects/prj_DEL1'), 'manager DELETE dipanggil tepat sekali');

    const reuse = await postForm(
      ctx.port,
      '/projects/prj_DEL1/delete',
      { confirmToken: ctx.tok },
      ctx.h(),
    );
    assert.equal(reuse.status, 403, 'token sekali pakai — reuse ditolak');
    assert.equal(ctx.calls.filter((c) => c === 'DELETE /projects/prj_DEL1').length, 1);
  });

  test('delete tanpa CSRF → 403 (CSRF tetap wajib di kedua fase)', async () => {
    const r = await postForm(
      ctx.port,
      '/projects/prj_DEL1/delete',
      {},
      { cookie: `vpanel_session=${ctx.sid}; vpanel_csrf=${ctx.csrf}` },
    );
    assert.equal(r.status, 403);
  });
});

// --- A2#28: transport manager down → 502 jelas --------------------------------

describe('PanelServer: manager UNREACHABLE → 502 pesan kanonik (A2#28)', () => {
  const ctx = {};

  before(async () => {
    const flaky = {
      ...OK_MANAGER,
      request: async (method) => {
        if (method === 'POST') {
          throw new VmPanelError(
            'UNREACHABLE',
            'cannot reach manager at http://127.0.0.1:8097 (connect ECONNREFUSED 127.0.0.1:8097)',
          );
        }
        return {};
      },
    };
    ctx.s = makeServer({ managerClient: flaky });
    await ctx.s.server.start();
    ctx.port = ctx.s.server.port;
    const codes = ctx.s.server.auth.issueRecoveryCodes('admin');
    const r = await postForm(ctx.port, '/login', {
      username: 'admin',
      password: 'password123',
      recoveryCode: codes[0],
    });
    ctx.sid = cookieValue(r.headers['set-cookie'], 'vpanel_session');
    ctx.csrf = cookieValue(r.headers['set-cookie'], 'vpanel_csrf');
  });

  after(async () => {
    await ctx.s.close();
  });

  test('POST /projects saat manager mati → 502 + "Manager tidak terjangkau" (tanpa detail socket)', async () => {
    const r = await postForm(
      ctx.port,
      '/projects',
      { name: 'x1', type: 'node' },
      { cookie: `vpanel_session=${ctx.sid}; vpanel_csrf=${ctx.csrf}`, 'x-csrf-token': ctx.csrf },
    );
    assert.equal(r.status, 502, `status 502 (dapat ${r.status})`);
    assert.ok(r.body.includes('Manager tidak terjangkau'), 'pesan kanonik tampil');
    assert.ok(!r.body.includes('ECONNREFUSED'), 'detail internal tidak bocor');
    assert.ok(!r.body.includes('127.0.0.1'), 'address internal tidak bocor');
  });
});

// --- A2#27: bootstrap satu token aktif ----------------------------------------

describe('PanelServer: bootstrap satu token aktif (A2#27)', () => {
  const ctx = {};

  before(async () => {
    // Server TANPA owner (tanpa bootstrap di makeServer) — bootstrap manual via HTTP.
    ctx.dataDir = mkdtempSync(join(tmpdir(), 'vpanel-boot-'));
    ctx.fixtures = makeFixtures();
    ctx.server = new PanelServer({
      rootDir: join(ctx.dataDir, 'root'),
      dataDir: ctx.dataDir,
      templatesDir: ctx.fixtures.templates,
      staticDir: ctx.fixtures.staticDir,
      managerClient: OK_MANAGER,
      config: DEFAULT_CONFIG,
    });
    await ctx.server.start();
    ctx.port = ctx.server.port;
  });

  after(async () => {
    await ctx.server.close();
    rmSync(ctx.fixtures.root, { recursive: true, force: true });
    rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('GET baru membatalkan token lama; hanya token terakhir yang berlaku', async () => {
    const g1 = await request(ctx.port, 'GET', '/bootstrap');
    assert.equal(g1.status, 200);
    const tok1 = String(g1.body.match(/name="token" value="([0-9a-f]+)"/)?.[1] ?? '');
    assert.ok(tok1.length === 64);

    const g2 = await request(ctx.port, 'GET', '/bootstrap');
    const tok2 = String(g2.body.match(/name="token" value="([0-9a-f]+)"/)?.[1] ?? '');
    assert.ok(tok2.length === 64 && tok1 !== tok2);

    const body1 = new URLSearchParams({ token: tok1, username: 'admin', password: 'password123', confirm: 'password123' }).toString();
    const r1 = await request(ctx.port, 'POST', '/bootstrap', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body1,
    });
    assert.equal(r1.status, 400, 'token lama sudah dibatalkan GET baru');
    assert.ok(r1.body.includes('Token setup tidak valid'));
    assert.equal(ctx.server.auth.perm.getUserByUsername('admin'), null, 'owner belum terbuat dari token basi');

    // reissue dari POST gagal juga SATU token aktif — ambil yang tampil di form
    // 400 ini, lalu validasi GET baru afterwards benar membatalkannya (A2#27).
    const tok3 = String(r1.body.match(/name="token" value="([0-9a-f]+)"/)?.[1] ?? '');
    assert.ok(tok3.length === 64 && tok3 !== tok2, 'reissue menghasilkan token fresh satu-satunya');

    const body2 = new URLSearchParams({ token: tok3, username: 'admin', password: 'password123', confirm: 'password123' }).toString();
    const r2 = await request(ctx.port, 'POST', '/bootstrap', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body2,
    });
    assert.equal(r2.status, 200, 'token aktif terakhir tetap valid');
    assert.ok(r2.body.includes('Owner dibuat') || r2.body.includes('bootstrap-totp'));
  });
});

// --- Lane 2c: render template NYATA (scan anti-tag-mentah §3 AGENTS) ----------
// makeServer di atas memakai template fixture; suite ini MENGGUNAKAN
// panel/templates asli agar tag {{note}} / {{supervisorStatusText}} /
// empty-state baru ikut terverifikasi end-to-end, bukan cuma lewat mock.

const REAL_TEMPLATES = fileURLToPath(new URL('../../panel/templates/', import.meta.url));

const SCOPED_PAGES = ['/dashboard', '/services', '/recovery', '/backups', '/deployments', '/logs', '/settings'];

function makeRealTemplateServer({ managerClient }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'vpanel-real-'));
  const fixtures = makeFixtures(); // staticDir fixture; templatesDir DI-OVERRIDE ke asli
  const server = new PanelServer({
    rootDir: join(dataDir, 'root'),
    dataDir,
    templatesDir: REAL_TEMPLATES,
    staticDir: fixtures.staticDir,
    managerClient,
    config: DEFAULT_CONFIG,
  });
  server.auth.bootstrapOwner({ username: 'admin', password: 'password123' });
  return {
    server,
    close: async () => {
      await server.close();
      rmSync(fixtures.root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function loginAdmin(port) {
  const r = await postForm(port, '/login', { username: 'admin', password: 'password123' });
  assert.equal(r.status, 302, 'login admin (localhost bypass)');
  const sid = cookieValue(r.headers['set-cookie'], 'vpanel_session');
  const csrf = cookieValue(r.headers['set-cookie'], 'vpanel_csrf');
  return { cookie: `vpanel_session=${sid}; vpanel_csrf=${csrf}`, csrf };
}

describe('Lane 2c: scan anti-tag-mentah pada template asli (§3 AGENTS)', () => {
  const ctx = {};

  before(async () => {
    // manager SEMI-OK: domain method hidup, route data generik (/services,
    // /deployments, /recovery/status, /backups, /logs/...) gagal → jalur
    // note=ENDPOINT_TODO_NOTE + MANAGER_DOWN_EMPTY ikut terpindai.
    ctx.s = makeRealTemplateServer({ managerClient: OK_MANAGER });
    await ctx.s.server.start();
    ctx.port = ctx.s.server.port;
    ctx.h = await loginAdmin(ctx.port);
  });

  after(async () => {
    await ctx.s.close();
  });

  test('manager semi-down → 7 halaman ter-render TANPA tag {{...}} bocor', async () => {
    for (const p of SCOPED_PAGES) {
      const r = await request(ctx.port, 'GET', p, { headers: { cookie: ctx.h.cookie } });
      assert.equal(r.status, 200, `${p} harus 200 (graceful), dapat ${r.status}`);
      const leaks = r.body.match(/\{\{[^}]+\}\}/g);
      assert.equal(leaks, null, `${p} membocorkan tag mentah: ${leaks && leaks.join(', ')}`);
    }
  });

  test('A4-H6: halaman data-manager-down pakai empty-state "Data tidak tersedia"', async () => {
    const res = await request(ctx.port, 'GET', '/services', { headers: { cookie: ctx.h.cookie } });
    assert.equal(res.status, 200);
    // buang komentar dokumentasi template (blok VARS) sebelum memeriksa isi
    const r = { ...res, body: res.body.replace(/<!--[\s\S]*?-->/g, '') };
    assert.ok(r.body.includes('Data tidak tersedia'), 'judul empty-state varian');
    assert.ok(r.body.includes('daemon mati'), 'hint menjelaskan penyebab mungkin basi');
    assert.ok(!r.body.includes('No services.'), 'empty-state normal tidak dipakai saat !ok');
    // A3-dead-note: note kini dirender ESCAPED sebagai teks biasa di halaman.
    assert.ok(r.body.includes('endpoint belum tersedia (F5)'), '{{note}} harus tampil');
  });

  test('A4-H5: teks supervisor dashboard proporsional (down → tidak terjangkau)', async () => {
    const r = await request(ctx.port, 'GET', '/dashboard', { headers: { cookie: ctx.h.cookie } });
    assert.equal(r.status, 200);
    // OK_MANAGER.systemStatus → status 'running' → sehat.
    assert.ok(r.body.includes('Supervisor healthy'), 'status running → Supervisor healthy');
    assert.ok(!r.body.includes('Supervisor tidak terjangkau'), 'bukan varian down');

    const down = {
      systemStatus: async () => {
        throw new VmPanelError('UNREACHABLE', 'cannot reach manager');
      },
    };
    const s2 = makeRealTemplateServer({
      managerClient: { ...OK_MANAGER, ...down },
    });
    try {
      await s2.server.start();
      const h2 = await loginAdmin(s2.server.port);
      const r2 = await request(s2.server.port, 'GET', '/dashboard', { headers: { cookie: h2.cookie } });
      assert.equal(r2.status, 200);
      assert.ok(r2.body.includes('Supervisor tidak terjangkau'), 'probe gagal → jujur tidak terjangkau');
      assert.ok(!/\{\{[^}]+\}\}/.test(r2.body), 'varian down pun bebas tag mentah');
    } finally {
      await s2.close();
    }
  });
});

describe('Lane 2c item 6: tombol "Import data" dashboard = anchor jujur', () => {
  test('anchor ke /projects#project-dropzone; tidak ada lagi window.location.reload()', () => {
    const dash = readFileSync(join(REAL_TEMPLATES, 'dashboard.html'), 'utf8');
    const anchor = dash.match(/<a\b[^>]*id="btn-header-import-data"[^>]*>/);
    assert.ok(anchor, 'btn-header-import-data harus <a> dengan id dipertahankan');
    assert.match(anchor[0], /href="\/projects#project-dropzone"/, 'href menuju entry import yang ada');
    assert.match(anchor[0], /class="[^"]*btn-oriont-outline/, 'kelas visual dipertahankan');
    assert.ok(!dash.includes('window.location.reload()'), 'dashboard bebas reload palsu (regresi tombol import)');
    // teks tertaut tetap menyebut aksi import (bukan label reload deviasi sesi mati)
    const idx = dash.indexOf('btn-header-import-data');
    assert.ok(dash.slice(idx, idx + 600).includes('Import data'), 'teks "Import data" dipertahankan');
  });
});

// --- Lane 2c item 5: projectId forwarding utk aksi per-project (A2#12) --------

describe('A2#12: operator ber-scope p1 — aksi p1 lolos, p2 → 403', () => {
  const ctx = {};

  before(async () => {
    ctx.posted = [];
    const client = {
      ...OK_MANAGER,
      listProjects: async () => [
        { id: 'prj_P1', name: 'alpha', status: 'running' },
        { id: 'prj_P2', name: 'beta', status: 'running' },
      ],
      request: async (method, path) => {
        if (method === 'GET' && path === '/services') {
          return {
            rows: [
              { id: 'svc_A', projectId: 'prj_P1', name: 'alpha', status: 'running', port: 20127 },
              { id: 'svc_B', projectId: 'prj_P2', name: 'beta', status: 'running', port: 20128 },
            ],
          };
        }
        if (method === 'GET' && /^\/projects\/prj_/.test(path)) {
          return { id: path.split('/')[2], name: 'x' };
        }
        if (method === 'POST' && /^\/projects\/prj_P[12]\/deploy$/.test(path)) {
          ctx.posted.push(path);
          return { ok: true };
        }
        if (method === 'POST' && /^\/services\/svc_[AB]\/(start|stop|restart)$/.test(path)) {
          ctx.posted.push(path);
          return { ok: true };
        }
        throw new VmPanelError('NOT_FOUND', `mock: rute tak diharapkan ${method} ${path}`);
      },
    };
    ctx.s = makeServer({ managerClient: client });
    await ctx.s.server.start();
    ctx.port = ctx.s.server.port;

    const perm = ctx.s.server.auth.perm;
    const owner = perm.getUserByUsername('admin');
    // operator dengan scope HANYA prj_P1
    const op = perm.createUser({ username: 'opsc', role: 'operator' });
    perm.approveUser(op.userId, owner.userId);
    perm.setProjectScope(op.userId, 'prj_P1', true);
    ctx.s.server.auth.setPassword('opsc', 'operatorpass1');
    const codes = ctx.s.server.auth.issueRecoveryCodes('opsc');
    const login = await postForm(ctx.port, '/login', {
      username: 'opsc',
      password: 'operatorpass1',
      recoveryCode: codes[0],
    });
    assert.equal(login.status, 302, 'login operator');
    ctx.opH = {
      cookie: `vpanel_session=${cookieValue(login.headers['set-cookie'], 'vpanel_session')}; vpanel_csrf=${cookieValue(login.headers['set-cookie'], 'vpanel_csrf')}`,
      'x-csrf-token': cookieValue(login.headers['set-cookie'], 'vpanel_csrf'),
    };
    // owner (tanpa scope rows) untuk kontrol global
    ctx.ownerH = await loginAdmin(ctx.port);
  });

  after(async () => {
    await ctx.s.close();
  });

  test('deploy prj_P1 → 302 (manager disentuh); prj_P2 → 403 (manager TIDAK disentuh)', async () => {
    const ok = await postForm(ctx.port, '/projects/prj_P1/deploy', {}, ctx.opH);
    assert.equal(ok.status, 302, `deploy project dalam scope harus lolos, dapat ${ok.status}: ${ok.body.slice(0, 200)}`);
    assert.ok(ctx.posted.includes('/projects/prj_P1/deploy'), 'teruskan ke manager');

    ctx.posted.length = 0;
    const denied = await postForm(ctx.port, '/projects/prj_P2/deploy', {}, ctx.opH);
    assert.equal(denied.status, 403, 'deploy di luar scope → 403');
    assert.ok(denied.body.includes('PERMISSION_DENIED'));
    assert.deepEqual(ctx.posted, [], 'gerbang menolak SEBELUM request ke manager');
  });

  test('service start svc_A (prj_P1) → 302; svc_B (prj_P2) → 403 via resolve serviceId→projectId', async () => {
    const ok = await postForm(ctx.port, '/services/svc_A/start', {}, ctx.opH);
    assert.equal(ok.status, 302, `start service milik project dalam scope lolos, dapat ${ok.status}`);
    assert.ok(ctx.posted.includes('/services/svc_A/start'));

    const denied = await postForm(ctx.port, '/services/svc_B/stop', {}, ctx.opH);
    assert.equal(denied.status, 403, 'stop service di luar scope → 403 (verb jujur service.stop)');
    assert.ok(!ctx.posted.includes('/services/svc_B/stop'), 'manager tak disentuh utk aksi ditolak');
  });

  test('owner tanpa scope: aksi prj_P2 tetap lolos (perilaku global tak berubah)', async () => {
    const r = await postForm(ctx.port, '/projects/prj_P2/deploy', {}, {
      cookie: ctx.ownerH.cookie,
      'x-csrf-token': ctx.ownerH.csrf,
    });
    assert.equal(r.status, 302, `owner harus selalu lolos, dapat ${r.status}`);
  });
});
