// tests/unit/panel-config-vault.test.js — Config & Brankas panel suite.
// PanelServer nyata (port ephemeral) + ManagerClient STUB (canned responses +
// rekam panggilan) — kontrak Manager API /secrets, /projects/:id/config,
// /projects/:id/env, /projects/:id/hook di-pin di sini. Bootstrap owner →
// login (password + TOTP) → render section (empty state) → vault-init →
// upload config (path textarea urlencoded + pass-through contentBase64) →
// delete dua fase (remove-request → remove, confirmToken dicek stub) →
// env set/delete → hook save/test(ok+gagal)/delete → CSRF 403 → manager
// down tetap 200 (banner + kartu graceful). Tanpa manager nyata.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelServer } from '../../panel/server/index.js';
import { VmPanelError, NOT_FOUND, VALIDATION, PERMISSION_DENIED } from '../../lib/errors.js';
import { totpGenerate } from '../../lib/crypto.js';

const PID = 'prj_stub01';

// --- stub ManagerClient --------------------------------------------------------

/**
 * Stub ManagerClient: implementasi `request(method, path, {query, body})`
 * + domain methods yang dipakai #managerGet (systemStatus/systemInfo/
 * health/listProjects/listAudit). Semua panggilan direkam di .calls;
 * confirmToken yang di-issue direkam di .tokens dan DIVALIDASI saat remove.
 */
class StubManagerClient {
  constructor() {
    this.calls = []; // {method, path, body}
    this.tokens = []; // confirmToken yang pernah di-issue
    this.initialized = false;
    this.secrets = [];
    this.configs = [];
    this.contentByFile = new Map(); // filename → contentBase64
    this.env = [];
    this.hook = null;
    this.testResult = { ok: true, status: 200, attempts: 1 };
    this.failAll = false; // semua endpoint throw (manager down)
    this.failVault = false; // hanya /secrets throw (vault tidak terbaca)
    this.seq = 0;
  }

  #record(method, path, body) {
    this.calls.push({ method, path, body: body ?? null });
  }

  /** Panggilan terakhir yang cocok (suffix match). */
  lastCall(method, suffix) {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if (c.method === method && c.path.endsWith(suffix)) return c;
    }
    return null;
  }

  async request(method, path, opts = {}) {
    this.#record(method, path, opts.body);
    if (this.failAll) throw new VmPanelError('UNREACHABLE', 'stub manager down');
    const m = method.toUpperCase();

    if (m === 'GET' && path === '/system/status') {
      return { status: 'ok', uptimeSec: 1, pid: 1, hostMode: 'dev', runnerId: 'stub', startedAt: '2026-09-01T00:00:00Z', version: '0' };
    }
    if (m === 'GET' && path === '/system/info') {
      return { name: 'manager-stub', version: '0', dataDir: 'stub' };
    }
    if (m === 'GET' && path === '/health') return { ok: true };
    if (m === 'GET' && path === '/projects') {
      return [{ id: PID, name: 'koper-app', type: 'static', status: 'running', createdAt: '2026-09-01T00:00:00Z' }];
    }
    if (m === 'GET' && path === `/projects/${PID}`) {
      return { id: PID, name: 'koper-app', type: 'static', status: 'running', repoUrl: 'https://github.com/example/koper-app', branch: 'main', createdAt: '2026-09-01T00:00:00Z' };
    }
    if (m === 'GET' && path === '/services') return { rows: [] };
    if (m === 'GET' && path === '/deployments') return { rows: [] };

    // --- secrets / vault ---
    if (m === 'GET' && path === '/secrets') {
      if (this.failVault) throw new VmPanelError('UNREACHABLE', 'stub vault down');
      if (!this.initialized) throw new VmPanelError(NOT_FOUND, 'brankas belum diinisialisasi');
      return { secrets: this.secrets };
    }
    if (m === 'POST' && path === '/secrets/init') {
      this.initialized = true;
      this.secrets = [
        { name: 'db_password', projectScope: PID, createdAt: '2026-09-01T00:00:00Z', rotatedAt: null, expiresAt: null },
        { name: 'api_key', projectScope: '', createdAt: '2026-09-01T00:00:00Z', rotatedAt: null, expiresAt: null },
      ];
      return {
        initialized: true,
        keyGenerated: true,
        vaultFile: 'secrets/vault.enc',
        refsFile: 'secrets/secrets.yaml',
        secretCount: this.secrets.length,
      };
    }
    // L5b: tulis/rotasi nilai (upsert) + hapus dua-fase — respons metadata-only.
    if (m === 'POST' && /^\/secrets\/[^/]+$/.test(path)) {
      const name = decodeURIComponent(path.slice('/secrets/'.length));
      const value = typeof opts.body?.value === 'string' ? opts.body.value : '';
      const scopeRaw = opts.body?.projectScope;
      const scope = scopeRaw === null || scopeRaw === undefined || scopeRaw === '' ? '' : String(scopeRaw);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw new VmPanelError(VALIDATION, 'nama secret tidak valid');
      }
      if (value === '' || Buffer.byteLength(value, 'utf8') > 4096) {
        throw new VmPanelError(VALIDATION, 'value wajib 1..4096 byte');
      }
      this.secrets = this.secrets.filter((s) => !(s.name === name && (s.projectScope || '') === scope));
      this.secrets.push({
        name,
        projectScope: scope,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-06T00:00:00Z',
        rotatedAt: null,
        expiresAt: null,
      });
      return { name, projectScope: scope, updatedAt: '2026-09-06T00:00:00Z' };
    }
    if (m === 'POST' && path.startsWith('/secrets/') && path.endsWith('/remove-request')) {
      const token = `sectok-${String(++this.seq).padStart(4, '0')}`;
      this.tokens.push(token);
      return { confirmToken: token, expiresAt: '2026-09-06T00:00:00Z' };
    }
    if (m === 'POST' && path.startsWith('/secrets/') && path.endsWith('/remove')) {
      const token = String(opts.body?.confirmToken ?? '');
      if (!this.tokens.includes(token)) {
        throw new VmPanelError(PERMISSION_DENIED, 'confirmToken manager tidak dikenal');
      }
      const name = decodeURIComponent(path.slice('/secrets/'.length).replace(/\/remove$/, ''));
      const scopeRaw = opts.body?.projectScope;
      const scope = scopeRaw === null || scopeRaw === undefined || scopeRaw === '' ? '' : String(scopeRaw);
      this.secrets = this.secrets.filter((s) => !(s.name === name && (s.projectScope || '') === scope));
      return { removed: true, name, projectScope: scope };
    }

    // --- project config files ---
    const cfgBase = `/projects/${PID}/config`;
    if (m === 'GET' && path === cfgBase) return { configs: this.configs };
    if (m === 'POST' && path === cfgBase) {
      const filename = String(opts.body?.filename ?? '');
      const contentBase64 = String(opts.body?.contentBase64 ?? '');
      const sizeBytes = Buffer.from(contentBase64, 'base64').length;
      const row = { filename, sizeBytes, sha256: 'a'.repeat(64), updatedAt: '2026-09-02T00:00:00Z' };
      this.configs.push(row);
      this.contentByFile.set(filename, contentBase64);
      return { projectId: PID, ...row };
    }
    if (m === 'POST' && path.startsWith(`${cfgBase}/`) && path.endsWith('/remove-request')) {
      const token = `cfgtok-${String(++this.seq).padStart(4, '0')}`;
      this.tokens.push(token);
      return { confirmToken: token, expiresAt: '2026-09-06T00:00:00Z' };
    }
    if (m === 'POST' && path.startsWith(`${cfgBase}/`) && path.endsWith('/remove')) {
      const token = String(opts.body?.confirmToken ?? '');
      if (!this.tokens.includes(token)) {
        throw new VmPanelError(VALIDATION, 'confirmToken tidak dikenal');
      }
      const f = decodeURIComponent(path.slice(cfgBase.length + 1, -'/remove'.length));
      this.configs = this.configs.filter((c) => c.filename !== f);
      this.contentByFile.delete(f);
      return { removed: true };
    }
    if (m === 'GET' && path.startsWith(`${cfgBase}/`)) {
      const f = decodeURIComponent(path.slice(cfgBase.length + 1));
      const row = this.configs.find((c) => c.filename === f);
      if (!row) throw new VmPanelError(NOT_FOUND, 'config tidak ditemukan');
      return {
        filename: row.filename,
        contentBase64: this.contentByFile.get(row.filename) ?? '',
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        updatedAt: row.updatedAt,
      };
    }

    // --- env mapping ---
    const envBase = `/projects/${PID}/env`;
    if (m === 'GET' && path === envBase) return { env: this.env };
    if (m === 'POST' && path === envBase) {
      const envName = String(opts.body?.envName ?? '');
      const secretName = String(opts.body?.secretName ?? '');
      const row = { envName, secretRef: `sec_${String(++this.seq).padStart(4, '0')}`, secretName };
      this.env.push(row);
      return row;
    }
    if (m === 'POST' && path.startsWith(`${envBase}/`) && path.endsWith('/remove-request')) {
      const token = `envtok-${String(++this.seq).padStart(4, '0')}`;
      this.tokens.push(token);
      return { confirmToken: token, expiresAt: '2026-09-06T00:00:00Z' };
    }
    if (m === 'POST' && path.startsWith(`${envBase}/`) && path.endsWith('/remove')) {
      const token = String(opts.body?.confirmToken ?? '');
      if (!this.tokens.includes(token)) {
        throw new VmPanelError(VALIDATION, 'confirmToken tidak dikenal');
      }
      const n = decodeURIComponent(path.slice(envBase.length + 1, -'/remove'.length));
      this.env = this.env.filter((e) => e.envName !== n);
      return { removed: true };
    }

    // --- startup hook ---
    const hookBase = `/projects/${PID}/hook`;
    if (m === 'GET' && path === hookBase) return { hook: this.hook };
    if (m === 'PUT' && path === hookBase) {
      this.hook = {
        url: String(opts.body?.url ?? ''),
        bodyFile: String(opts.body?.bodyFile ?? ''),
        secretFields: Array.isArray(opts.body?.secretFields) ? opts.body.secretFields : [],
        updatedAt: '2026-09-03T00:00:00Z',
      };
      return { hook: this.hook };
    }
    if (m === 'POST' && path === `${hookBase}/test`) return this.testResult;
    if (m === 'POST' && path === `${hookBase}/remove-request`) {
      const token = `hooktok-${String(++this.seq).padStart(4, '0')}`;
      this.tokens.push(token);
      return { confirmToken: token, expiresAt: '2026-09-06T00:00:00Z' };
    }
    if (m === 'POST' && path === `${hookBase}/remove`) {
      const token = String(opts.body?.confirmToken ?? '');
      if (!this.tokens.includes(token)) {
        throw new VmPanelError(VALIDATION, 'confirmToken tidak dikenal');
      }
      this.hook = null;
      return { removed: true };
    }

    throw new VmPanelError(NOT_FOUND, `stub: route tidak dikenal ${method} ${path}`);
  }

  // Domain methods (dipakai #managerGet bila path terdaftar di map).
  systemStatus() {
    return this.request('GET', '/system/status');
  }
  systemInfo() {
    return this.request('GET', '/system/info');
  }
  health() {
    return this.request('GET', '/health');
  }
  listProjects() {
    return this.request('GET', '/projects');
  }
  listAudit() {
    return { rows: [], total: 0 };
  }
}

// --- fetch helpers dengan cookie manual (pola panel-e2e) ----------------------

function cookieJarFromResponse(res, jar) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of setCookies) {
    const m = String(line).match(/^\s*([^=;\s]+)=([^;]*)/);
    if (m) jar.set(m[1], m[2]);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(port, method, path, { jar, headers = {}, body = null, redirect = 'manual' } = {}) {
  const h = { ...headers };
  if (jar) h.cookie = cookieHeader(jar);
  if (body !== null) h['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: h,
    body: body === null ? undefined : body,
    redirect,
  });
  if (jar) cookieJarFromResponse(res, jar);
  return res;
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

// --- konteks -------------------------------------------------------------------

const ctx = {};

before(async () => {
  ctx.dir = mkdtempSync(join(tmpdir(), 'vmpanel-cfgvault-'));
  ctx.panelData = mkdtempSync(join(tmpdir(), 'vmpanel-cfgvault-panel-'));
  ctx.stub = new StubManagerClient();
  ctx.panel = new PanelServer({
    rootDir: ctx.dir,
    dataDir: ctx.panelData,
    config: { panel: { port: 0, ratePerMin: 1000, loginRatePerMin: 1000 } },
    managerClient: ctx.stub,
  });
  await ctx.panel.start();
  ctx.port = ctx.panel.port;

  // Bootstrap owner langsung via PanelAuth (pola panel-server.test.js)
  const boot = ctx.panel.auth.bootstrapOwner({ username: 'admin', password: 'ownerpass123' });
  assert.ok(boot.totpSecretBase32, 'TOTP secret bootstrap ada');

  // Login → session + csrf cookie
  const jar = new Map();
  const login = await req(ctx.port, 'POST', '/login', {
    jar,
    body: form({ username: 'admin', password: 'ownerpass123', totp: totpGenerate(boot.totpSecretBase32) }),
  });
  assert.equal(login.status, 302, 'login owner sukses');
  assert.ok(jar.has('vpanel_session'), 'session cookie');
  assert.ok(jar.has('vpanel_csrf'), 'csrf cookie');
  ctx.jar = jar;
});

after(async () => {
  if (ctx.panel) await ctx.panel.close();
  if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
  if (ctx.panelData) rmSync(ctx.panelData, { recursive: true, force: true });
});

async function getPage() {
  const res = await req(ctx.port, 'GET', `/projects/${PID}`, { jar: ctx.jar });
  assert.equal(res.status, 200, 'detail project 200');
  return res.text();
}

function csrfHeaders() {
  return { 'x-csrf-token': ctx.jar.get('vpanel_csrf') };
}

/**
 * A2#13: hapus destruktif kini dua-fase di sisi SERVER — POST pertama tanpa
 * token mengembalikan halaman konfirmasi (200) TANPA menyentuh manager; POST
 * kedua membawa confirmToken sekali-pakai baru mengeksekusi (302). Helper
 * menjalankan kedua fase; assertion rantai manager tetap di test pemanggil.
 */
async function twoPhaseRemove(path, removedCallMatcher) {
  const callsBefore = ctx.stub.calls.filter(removedCallMatcher).length;
  const r1 = await req(ctx.port, 'POST', path, { jar: ctx.jar, headers: csrfHeaders(), body: form({}) });
  assert.equal(r1.status, 200, 'fase-1: halaman konfirmasi (BUKAN eksekusi langsung)');
  const html1 = await r1.text();
  assert.equal(
    ctx.stub.calls.filter(removedCallMatcher).length,
    callsBefore,
    'fase-1 tidak boleh memanggil manager /remove',
  );
  const tok = (html1.match(/name="confirmToken" value="([^"]+)"/) || [])[1];
  assert.ok(tok && /^[0-9a-f]{64}$/.test(tok), 'token konfirmasi sekali-pakai dirender');
  return req(ctx.port, 'POST', path, { jar: ctx.jar, headers: csrfHeaders(), body: form({ confirmToken: tok }) });
}

// --- tests -----------------------------------------------------------------------

describe('panel-config-vault (Config & Brankas)', () => {
  test('(1) section dirender dengan empty state + permission owner', async () => {
    const text = await getPage();
    assert.ok(text.includes('href="#config-vault"'), 'tab Config & Brankas ada');
    assert.ok(text.includes('id="config-vault"'), 'section ada');
    assert.ok(text.includes('Brankas belum diinisialisasi'), 'status brankas belum init');
    assert.ok(text.includes('Nyalakan Brankas'), 'tombol init tampil');
    assert.ok(text.includes('Belum ada config koper.'), 'empty state config koper');
    assert.ok(text.includes('Belum ada variabel terhubung.'), 'empty state env');
    assert.ok(text.includes('Suntikan belum dipasang.'), 'empty state hook');
    assert.ok(text.includes('action="/projects/prj_stub01/vault-init"'), 'form init POST ke panel');
  });

  test('(2) POST vault-init → manager /secrets/init dipanggil → status aktif + note', async () => {
    const res = await req(ctx.port, 'POST', `/projects/${PID}/vault-init`, {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({}),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/projects/${PID}`);
    const init = ctx.stub.lastCall('POST', '/secrets/init');
    assert.ok(init, 'manager POST /secrets/init dipanggil');

    const text = await getPage();
    assert.ok(text.includes('Brankas aktif — 2 rahasia'), 'status aktif + jumlah rahasia');
    assert.ok(text.includes('Simpan cadangan kunci .env di tempat aman.'), 'note cadangan kunci');
    assert.ok(!text.includes('Nyalakan Brankas'), 'tombol init hilang setelah aktif');
    // opsi rahasia kini tersedia di form env + hook
    assert.ok(text.includes('>db_password</option>'), 'opsi rahasia db_password');
    assert.ok(text.includes('>api_key</option>'), 'opsi rahasia api_key');
  });

  test('(3) upload config (textarea urlencoded) → manager terima {filename, contentBase64}', async () => {
    const content = JSON.stringify({ database: { host: '127.0.0.1' }, hello: 'config-isi' });
    const res = await req(ctx.port, 'POST', `/projects/${PID}/config`, {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({ filename: 'settings.json', contentRaw: content }),
    });
    assert.equal(res.status, 302, 'upload sukses → redirect');
    const call = ctx.stub.lastCall('POST', `/projects/${PID}/config`);
    assert.ok(call, 'manager POST /projects/:id/config dipanggil');
    assert.equal(call.body.filename, 'settings.json');
    assert.equal(
      Buffer.from(call.body.contentBase64, 'base64').toString('utf8'),
      content,
      'contentBase64 = base64 dari isi textarea',
    );

    const text = await getPage();
    assert.ok(text.includes('<td class="mono">settings.json</td>'), 'file di tabel config');
    assert.ok(text.includes('config-isi'), 'isi file ter-render (pratinjau Lihat, decode server-side)');
    assert.ok(text.includes('data-reveal="#cv-view-0"'), 'tombol Lihat pakai data-reveal');
    assert.ok(text.includes('data-confirm-phrase="settings.json"'), 'hapus memakai phrase nama file');
    assert.ok(!text.includes('confirmToken'), 'confirmToken tidak pernah bocor ke UI');
  });

  test('(4) upload pass-through contentBase64 (path file picker panel.js) diteruskan apa adanya', async () => {
    const b64 = Buffer.from('PASSTHROUGH-CONTENT', 'utf8').toString('base64');
    const res = await req(ctx.port, 'POST', `/projects/${PID}/config`, {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({ filename: 'passthrough.txt', contentBase64: b64 }),
    });
    assert.equal(res.status, 302);
    const call = ctx.stub.lastCall('POST', `/projects/${PID}/config`);
    assert.equal(call.body.filename, 'passthrough.txt');
    assert.equal(call.body.contentBase64, b64, 'contentBase64 diteruskan tanpa diubah');
  });

  test('(5) upload > 512KB → 400 VALIDATION (cap server-side)', async () => {
    const big = 'x'.repeat(600 * 1024);
    const res = await req(ctx.port, 'POST', `/projects/${PID}/config`, {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({ filename: 'big.txt', content: big }),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(text.includes('512'), 'pesan menyebut batas 512 KB');
  });

  test('(6) env set → manager POST /projects/:id/env + baris di tabel', async () => {
    const res = await req(ctx.port, 'POST', `/projects/${PID}/env`, {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({ envName: 'DB_PASSWORD', secretName: 'db_password' }),
    });
    assert.equal(res.status, 302);
    const call = ctx.stub.lastCall('POST', `/projects/${PID}/env`);
    assert.ok(call, 'manager env endpoint dipanggil');
    assert.equal(call.body.envName, 'DB_PASSWORD');
    assert.equal(call.body.secretName, 'db_password');

    const text = await getPage();
    assert.ok(text.includes('<td class="mono">DB_PASSWORD</td>'), 'envName di tabel');
    assert.ok(text.includes('<td class="mono">db_password</td>'), 'secretName (nama saja) di tabel');
  });

  test('(7) hook save → manager PUT + kartu menampilkan url + Test sekarang', async () => {
    const res = await req(ctx.port, 'POST', `/projects/${PID}/hook`, {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({
        hookUrl: 'http://127.0.0.1:3456/api/settings/database',
        hookBodyFile: 'settings.json',
        hookFieldName: 'password',
        hookSecretName: 'db_password',
      }),
    });
    assert.equal(res.status, 302);
    const put = ctx.stub.lastCall('PUT', `/projects/${PID}/hook`);
    assert.ok(put, 'manager PUT /projects/:id/hook dipanggil');
    assert.equal(put.body.url, 'http://127.0.0.1:3456/api/settings/database');
    assert.equal(put.body.bodyFile, 'settings.json');
    assert.deepEqual(put.body.secretFields, [{ fieldName: 'password', secretName: 'db_password' }]);

    const text = await getPage();
    assert.ok(text.includes('http://127.0.0.1:3456/api/settings/database'), 'url hook tampil');
    assert.ok(text.includes('Test sekarang'), 'tombol test tampil');
  });

  test('(8) hook test sukses → badge Tersambung', async () => {
    ctx.stub.testResult = { ok: true, status: 200, attempts: 1 };
    const res = await req(ctx.port, 'POST', `/projects/${PID}/hook/test`, {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({}),
    });
    assert.equal(res.status, 302);
    const call = ctx.stub.lastCall('POST', `/projects/${PID}/hook/test`);
    assert.ok(call, 'manager hook/test dipanggil');
    const text = await getPage();
    assert.ok(text.includes('Tersambung'), 'badge sukses tampil');
  });

  test('(9) hook test gagal → badge gagal + pesan error', async () => {
    ctx.stub.testResult = { ok: false, attempts: 3, error: 'connect ECONNREFUSED 127.0.0.1:3456' };
    const res = await req(ctx.port, 'POST', `/projects/${PID}/hook/test`, {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({}),
    });
    assert.equal(res.status, 302);
    const text = await getPage();
    assert.ok(text.includes('Tidak tersambung'), 'badge gagal tampil');
    assert.ok(text.includes('connect ECONNREFUSED 127.0.0.1:3456'), 'teks error tampil');
  });

  test('(10) config delete → dua-fase server panel lalu dua-fase manager chain', async () => {
    const res = await twoPhaseRemove(
      `/projects/${PID}/config/settings.json/remove`,
      (c) => c.method === 'POST' && c.path.includes('/config/settings%2Ejson/remove'),
    );
    assert.equal(res.status, 302);
    // remove-request → manager path dengan segmen filename ter-encode (titik
    // di-escape panel agar segmen tidak bisa dipakai traversal).
    const rr = ctx.stub.lastCall('POST', '/config/settings%2Ejson/remove-request');
    assert.ok(rr, 'remove-request dipanggil');
    assert.equal(typeof rr.body, 'object', 'remove-request membawa body {}');
    const rm = ctx.stub.lastCall('POST', '/config/settings%2Ejson/remove');
    assert.ok(rm, 'remove dipanggil setelahnya');
    assert.ok(rm.body && typeof rm.body.confirmToken === 'string' && rm.body.confirmToken !== '', 'remove membawa confirmToken');
    assert.ok(ctx.stub.tokens.includes(rm.body.confirmToken), 'token berasal dari remove-request');

    const text = await getPage();
    assert.ok(!text.includes('data-reveal="#cv-view-1"'), 'pratinjau file kedua hilang');
    assert.ok(text.includes('passthrough.txt'), 'file lain tetap ada');
  });

  test('(11) env delete → dua-fase server panel lalu chain manager', async () => {
    const res = await twoPhaseRemove(
      `/projects/${PID}/env/DB_PASSWORD/remove`,
      (c) => c.method === 'POST' && c.path.includes('/env/DB_PASSWORD/remove'),
    );
    assert.equal(res.status, 302);
    const rm = ctx.stub.lastCall('POST', '/remove');
    assert.ok(rm && rm.path.includes('/env/DB_PASSWORD/remove'), 'remove env dipanggil');
    assert.ok(ctx.stub.tokens.includes(rm.body.confirmToken), 'confirmToken dari remove-request');
    const text = await getPage();
    assert.ok(!text.includes('<td class="mono">DB_PASSWORD</td>'), 'baris env hilang');
  });

  test('(12) hook delete → dua-fase server panel lalu chain manager → empty state', async () => {
    const res = await twoPhaseRemove(
      `/projects/${PID}/hook/remove`,
      (c) => c.method === 'POST' && c.path.endsWith('/hook/remove'),
    );
    assert.equal(res.status, 302);
    const rm = ctx.stub.lastCall('POST', '/remove');
    assert.ok(rm && rm.path.endsWith('/hook/remove'), 'hook remove dipanggil');
    assert.ok(ctx.stub.tokens.includes(rm.body.confirmToken), 'confirmToken dari remove-request');
    const text = await getPage();
    assert.ok(text.includes('Suntikan belum dipasang.'), 'empty state hook kembali');
  });

  test('(13) POST aksi tanpa CSRF → 403', async () => {
    const res = await req(ctx.port, 'POST', `/projects/${PID}/vault-init`, {
      jar: ctx.jar,
      body: form({}),
    });
    assert.equal(res.status, 403);
    const res2 = await req(ctx.port, 'POST', `/projects/${PID}/config`, {
      jar: ctx.jar,
      body: form({ filename: 'x.txt', content: 'x' }),
    });
    assert.equal(res2.status, 403);
  });

  test('(14) vault gagal dibaca (manager partial down) → kartu graceful "Manager tidak merespons"', async () => {
    ctx.stub.failVault = true;
    const text = await getPage();
    assert.ok(text.includes('Manager tidak merespons'), 'status line fallback di kartu Brankas');
    ctx.stub.failVault = false;
  });

  test('(15) manager total down → detail tetap 200 + banner graceful', async () => {
    ctx.stub.failAll = true;
    const res = await req(ctx.port, 'GET', `/projects/${PID}`, { jar: ctx.jar });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Manager tidak terjangkau'), 'banner manager down');
    assert.ok(!text.includes('Terjadi kesalahan internal'), 'tanpa crash');
    ctx.stub.failAll = false;
  });

  // ── L5b: jalur input NILAI rahasia dari kartu Brankas ─────────────────────
  const SEKRET = 'SEKRITPALSUxyz-panel-l5b';

  test('(16) kartu Brankas punya form nilai (password-masked) + tabel metadata', async () => {
    const text = await getPage();
    assert.ok(text.includes('action="/vault/secret"'), 'form simpan rahasia POST ke /vault/secret');
    assert.ok(text.includes('type="password"'), 'input nilai ter-mask');
    assert.ok(text.includes('autocomplete="new-password"'), 'browser tidak menyimpan nilai');
    assert.ok(text.includes('name="projectScope"'), 'pemilih cakupan ada');
    assert.ok(text.includes('data-confirm="Simpan rahasia ke Brankas?"'), 'Simpan berkunci dialog');
    assert.ok(text.includes('>db_password</td>'), 'rahasia existing tampil sebagai sel tabel metadata');
    assert.ok(text.includes('name="name" value="db_password"'), 'tombol Hapus per baris memakai aksi dua-fase');
    assert.ok(!text.includes(SEKRET), 'nilai tidak pernah muncul di HTML');
  });

  test('(17) POST /vault/secret → manager menerima nilai, halaman TANPA nilai', async () => {
    const res = await req(ctx.port, 'POST', '/vault/secret', {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({ name: 'OPENAI_API_KEY', value: SEKRET, projectScope: '', projectId: PID }),
    });
    assert.equal(res.status, 302, 'sukses → redirect balik ke halaman detail');
    assert.equal(res.headers.get('location'), `/projects/${PID}`);
    assert.ok(!res.headers.get('location').includes(SEKRET));
    const call = ctx.stub.lastCall('POST', '/secrets/OPENAI_API_KEY');
    assert.ok(call, 'panel meneruskan POST /secrets/:name ke manager');
    assert.equal(call.body.value, SEKRET, 'nilai hanya lewat body ke manager');
    assert.equal(call.body.projectScope, null, 'cakupan global dikirim sebagai null');

    const text = await getPage();
    // presence dicek dari form Hapus per-baris (bukan placeholder input form)
    assert.ok(
      text.includes('name="name" value="OPENAI_API_KEY"'),
      'metadata nama tampil sebagai baris tabel brankas',
    );
    assert.ok(!text.includes(SEKRET), 'nilai haram muncul di HTML');
  });

  test('(18) /vault/secret: nama/nilai invalid ditolak server-side, CSRF wajib', async () => {
    const post = (fields) =>
      req(ctx.port, 'POST', '/vault/secret', {
        jar: ctx.jar,
        headers: csrfHeaders(),
        body: form(fields),
      });
    const badName = await post({ name: 'bad-name', value: 'x', projectId: PID });
    assert.notEqual(badName.status, 302, 'nama invalid tidak boleh dianggap sukses');
    assert.ok((await badName.text()).includes('Nama rahasia tidak valid'));
    const emptyVal = await post({ name: 'OK_NAME', value: '', projectId: PID });
    assert.ok((await emptyVal.text()).includes('Nilai rahasia wajib diisi'));
    const bigVal = await post({ name: 'OK_NAME', value: 'A'.repeat(4097), projectId: PID });
    assert.ok((await bigVal.text()).includes('terlalu besar'));
    assert.equal(ctx.stub.lastCall('POST', '/secrets/OK_NAME'), null, 'validasi gagal → tidak ada panggilan manager');

    const callsBefore = ctx.stub.calls.length;
    const noCsrf = await req(ctx.port, 'POST', '/vault/secret', {
      jar: ctx.jar,
      body: form({ name: 'NO_CSRF', value: 'x', projectId: PID }),
    });
    assert.equal(noCsrf.status, 403, 'tanpa CSRF token → ditolak');
    assert.equal(ctx.stub.calls.length, callsBefore, 'tanpa CSRF tidak ada panggilan manager');
  });

  test('(19) /vault/secret-remove dua-fase → chain manager remove-request + remove', async () => {
    const fields = { name: 'OPENAI_API_KEY', projectScope: '', projectId: PID };
    const removeMatcher = (c) => c.method === 'POST' && c.path === '/secrets/OPENAI_API_KEY/remove';
    const before = ctx.stub.calls.filter(removeMatcher).length;

    const r1 = await req(ctx.port, 'POST', '/vault/secret-remove', {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form(fields),
    });
    assert.equal(r1.status, 200, 'fase-1 = halaman konfirmasi, bukan eksekusi');
    const html1 = await r1.text();
    assert.ok(html1.includes('Konfirmasi hapus rahasia'), 'halaman konfirmasi fase-1');
    assert.ok(html1.includes('name="name" value="OPENAI_API_KEY"'), 'identitas terbawa ke fase-2');
    assert.ok(!html1.includes(SEKRET), 'fase-1 tidak memuat nilai');
    assert.equal(ctx.stub.calls.filter(removeMatcher).length, before, 'fase-1 jangan memanggil remove');
    const tok = (html1.match(/name="confirmToken" value="([^"]+)"/) || [])[1];
    assert.ok(tok && /^[0-9a-f]{64}$/.test(tok), 'token panel sekali-pakai dirender');

    const bogus = await req(ctx.port, 'POST', '/vault/secret-remove', {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({ ...fields, confirmToken: 'f'.repeat(64) }),
    });
    assert.notEqual(bogus.status, 302, 'token palsu tidak boleh eksekusi');
    assert.ok((await bogus.text()).includes('Token konfirmasi tidak valid'));
    assert.equal(ctx.stub.calls.filter(removeMatcher).length, before, 'token palsu berhenti di panel');

    const r2 = await req(ctx.port, 'POST', '/vault/secret-remove', {
      jar: ctx.jar,
      headers: csrfHeaders(),
      body: form({ ...fields, confirmToken: tok }),
    });
    assert.equal(r2.status, 302, 'fase-2 tereksekusi');
    assert.ok(ctx.stub.lastCall('POST', '/secrets/OPENAI_API_KEY/remove-request'), 'remove-request lebih dulu');
    assert.equal(ctx.stub.calls.filter(removeMatcher).length, before + 1, 'fase-2 men-chain manager remove');

    const text = await getPage();
    assert.ok(
      !text.includes('name="name" value="OPENAI_API_KEY"'),
      'baris tabel + tombol Hapus rahasia hilang setelah dua-fase',
    );
    assert.ok(!text.includes('>OPENAI_API_KEY</td>'), 'sel tabel nama ikut hilang');
  });
});
