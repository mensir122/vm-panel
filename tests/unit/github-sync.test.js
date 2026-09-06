// tests/unit/github-sync.test.js — E2E "Sync ke GitHub" (panel sebagai remote
// control untuk GitHub Actions runner).
// Pola projects-ui.test.js: Manager + Panel nyata di sandbox (rootDir sandbox —
// manifest projects.auto.json ditulis ke sandbox, BUKAN repo asli), bootstrap
// owner, login (password + TOTP), cookie manual + header X-CSRF-Token.
//
// Skenario (urutan menyesuaikan state disk):
//   (setup)  bootstrap owner + login
//   (1)      GET /projects/sync-status → {exists: false} (manifest belum ada)
//   (2)      buat 2 project via POST /projects (satu dengan repo_url, satu tanpa)
//   (4)      POST /projects/sync-to-github tanpa repo git → error pesan jelas
//            (bukan crash); manifest SUDAH tertulis di disk (write sebelum git)
//   (3)      GET /projects/sync-status → {exists: true, content: entry dengan
//            repo_url} — sesuai skenario 3 spesifikasi
//   (5)      git init sandbox + remote origin → bare repo lokal → POST sync
//            → redirect sukses + manifest ter-commit di bare repo + alert hijau
//   (6)      viewer/operator → 403 (khusus owner)
//   (7)      POST tanpa CSRF → 403
//
// Git availability guard (pola projects-ui.test.js): test yang butuh git
// di-skip bila git tidak tersedia; sisanya tetap jalan.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Manager } from '../../manager/index.js';
import { PanelServer } from '../../panel/server/index.js';
import { ManagerClient } from '../../lib/api-client.js';
import { totpGenerate } from '../../lib/crypto.js';

const execFileP = promisify(execFile);

function randomHighPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

// --- fetch helpers dengan cookie manual (pola panel-e2e.test.js) --------------

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
  if (jar) h.cookie = jar.has('cookie') ? `${jar.get('cookie')}; ${cookieHeader(jar)}` : cookieHeader(jar);
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

// --- git availability guard ---------------------------------------------------

let gitAvailable = false;
try {
  await execFileP(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { timeout: 10000 });
  gitAvailable = true;
} catch {
  gitAvailable = false; // test (5) skip; test lain (tanpa git nyata) tetap jalan
}

// --- konteks -------------------------------------------------------------------

const ctx = {};

before(async () => {
  ctx.dir = mkdtempSync(join(tmpdir(), 'vmpanel-ghsync-'));
  mkdirSync(join(ctx.dir, 'logs', 'projects'), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    ctx.manager = new Manager({
      rootDir: ctx.dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'ghsync-manager-token-0123456789abcdef',
    });
    try {
      await ctx.manager.start();
      break;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  ctx.panelData = mkdtempSync(join(tmpdir(), 'vmpanel-ghsync-panel-'));
  ctx.remoteDir = mkdtempSync(join(tmpdir(), 'vmpanel-ghsync-remote-'));
  ctx.bare = join(ctx.remoteDir, 'origin.git');
  ctx.managerClient = new ManagerClient({ port: ctx.manager.api.port, token: ctx.manager.token });
  // rootDir = sandbox → projects.auto.json ditulis DI SANDBOX, bukan repo asli.
  ctx.panel = new PanelServer({
    rootDir: ctx.dir,
    dataDir: ctx.panelData,
    config: { panel: { port: 0, ratePerMin: 1000, loginRatePerMin: 1000 }, manager: { apiPort: ctx.manager.api.port } },
    managerClient: ctx.managerClient,
    auditManager: ctx.manager.auditManager,
  });
  await ctx.panel.start();
  ctx.port = ctx.panel.port;

  // Fixture repo lokal (repo_url divalidasi manager, tidak pernah di-clone
  // dalam suite ini — jadi tanpa git pun path absolut tetap valid).
  ctx.repoPath = join(ctx.dir, 'fixture-repo');
  mkdirSync(ctx.repoPath, { recursive: true });
  writeFileSync(join(ctx.repoPath, 'index.html'), '<!doctype html><body>ghsync</body></html>\n');
  if (gitAvailable) {
    const opts = { cwd: ctx.repoPath, timeout: 30000 };
    await execFileP('git', ['init'], opts);
    await execFileP('git', ['config', 'user.email', 'test@example.local'], opts);
    await execFileP('git', ['config', 'user.name', 'VM Panel Test'], opts);
    await execFileP('git', ['add', 'index.html'], opts);
    await execFileP('git', ['commit', '-m', 'fixture'], opts);
  }
});

after(async () => {
  if (ctx.panel) await ctx.panel.close();
  if (ctx.manager && ctx.manager.running) await ctx.manager.stop();
  // Windows: handle file bisa tertahan sesaat → rmSync best-effort retry.
  await delay(500);
  for (const d of [ctx.dir, ctx.panelData, ctx.remoteDir]) {
    if (!d) continue;
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch {
        await delay(300);
      }
    }
  }
});

describe('github-sync (panel → GitHub Actions runner)', () => {
  test('(setup) bootstrap owner + login → cookie session + csrf', async () => {
    const jar = new Map();
    const boot = await req(ctx.port, 'GET', '/bootstrap', { jar });
    assert.equal(boot.status, 200);
    const bootHtml = await boot.text();
    const token = String(bootHtml.match(/name="token" value="([0-9a-f]+)"/)?.[1] ?? '');
    assert.ok(token.length >= 32);
    const bootRes = await req(ctx.port, 'POST', '/bootstrap', {
      jar,
      body: form({ token, username: 'admin', password: 'ownerpass123', confirm: 'ownerpass123' }),
    });
    assert.equal(bootRes.status, 200);
    const secret = (await bootRes.text()).match(/id="bootstrap-totp"[^>]*>([A-Z2-7]+)</)?.[1];
    assert.ok(secret, 'TOTP secret owner');

    const login = await req(ctx.port, 'POST', '/login', {
      jar,
      body: form({ username: 'admin', password: 'ownerpass123', totp: totpGenerate(secret) }),
    });
    assert.equal(login.status, 302);
    assert.ok(jar.has('vpanel_session') && jar.has('vpanel_csrf'), 'cookie session+csrf');
    ctx.ownerJar = jar;
  });

  test('(1) GET /projects/sync-status → {exists: false} (manifest belum ada)', async () => {
    const res = await req(ctx.port, 'GET', '/projects/sync-status', { jar: ctx.ownerJar });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.exists, false, 'manifest belum ada di sandbox rootDir');
  });

  test('(2) buat 2 project (dengan repo_url / tanpa) via POST /projects', async () => {
    for (const spec of [
      { name: 'sync-with-repo', type: 'static', port: String(randomHighPort()), repo_url: ctx.repoPath },
      { name: 'sync-local-only', type: 'static' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await req(ctx.port, 'POST', '/projects', {
        jar: ctx.ownerJar,
        headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
        body: form(spec),
      });
      assert.equal(res.status, 302, `sukses → redirect (${spec.name})`);
      assert.match(res.headers.get('location') ?? '', /^\/projects\/prj_/, 'redirect ke detail');
    }
  });

  test('(4) sync tanpa remote git → error pesan jelas (bukan crash)', async () => {
    // Sandbox rootDir BELUM repo git → git add gagal dengan pesan jelas
    // (bukan 500 INTERNAL). NB: manifest tetap sudah tertulis di disk
    // (tahap write terjadi sebelum git add).
    const res = await req(ctx.port, 'POST', '/projects/sync-to-github', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(res.status, 502, 'gagal sync → 502, bukan 500 crash');
    const text = await res.text();
    assert.ok(text.includes('alert--error'), 'alert merah tampil');
    assert.ok(text.includes('gagal'), 'pesan error jelas untuk pemula');
    assert.ok(!text.includes('Terjadi kesalahan internal'), 'tidak crash INTERNAL');
    assert.ok(
      text.includes('git') && (text.includes('repo') || text.includes('add')),
      'pesan menyebut langkah git yang gagal',
    );
  });

  test('(3) GET /projects/sync-status → {exists: true, content: entry repo_url}', async () => {
    // Setelah attempt (4), manifest materialize di disk: 1 project dengan
    // repo_url masuk manifest; project tanpa repo_url di-skip.
    const res = await req(ctx.port, 'GET', '/projects/sync-status', { jar: ctx.ownerJar });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.exists, true);
    assert.ok(typeof body.lastModified === 'string' && body.lastModified.length > 0, 'lastModified (mtime)');
    assert.ok(Array.isArray(body.content), 'content parsed array');
    assert.ok(body.content.length >= 1 && body.content.length <= 2, '1-2 entry');
    const entry = body.content[0];
    assert.equal(entry.name, 'sync-with-repo');
    assert.ok(typeof entry.repo_url === 'string' && entry.repo_url.includes('fixture-repo'), 'repo_url terisi');
    assert.equal(entry.enabled, true);
    assert.ok(!body.content.some((e) => e.name === 'sync-local-only'), 'project tanpa repo_url di-skip');
  });

  test('(5) remote origin → bare repo lokal → sync sukses + commit di bare repo', { skip: !gitAvailable }, async () => {
    // Siapkan repo git di sandbox rootDir (cwd git sync = rootDir):
    // branch main (panel push `git push origin main`), identitas lokal.
    const opts = { cwd: ctx.dir, timeout: 30000 };
    await execFileP('git', ['init'], opts);
    await execFileP('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], opts);
    await execFileP('git', ['config', 'user.email', 'test@example.local'], opts);
    await execFileP('git', ['config', 'user.name', 'VM Panel Test'], opts);
    await execFileP('git', ['init', '--bare', ctx.bare], { timeout: 30000 });
    await execFileP('git', ['remote', 'add', 'origin', ctx.bare], opts);

    const res = await req(ctx.port, 'POST', '/projects/sync-to-github', {
      jar: ctx.ownerJar,
      headers: { 'x-csrf-token': ctx.ownerJar.get('vpanel_csrf') },
      body: form({}),
    });
    assert.equal(res.status, 302, 'sync sukses → redirect /projects');

    // Manifest di disk ter-update (isi konsisten dengan manager).
    const status = await req(ctx.port, 'GET', '/projects/sync-status', { jar: ctx.ownerJar });
    const body = await status.json();
    assert.equal(body.exists, true);
    assert.ok(Array.isArray(body.content) && body.content.length === 1);
    assert.equal(body.content[0].name, 'sync-with-repo');
    assert.equal(body.content[0].git_branch, 'main');

    // Commit tercatat di bare repo (tujuan push origin main).
    const log = await execFileP(
      'git',
      ['--git-dir=' + ctx.bare, 'log', '-1', '--format=%s', 'refs/heads/main'],
      { timeout: 30000 },
    );
    assert.equal(
      log.stdout.trim(),
      'sync: update projects.auto.json dari panel',
      'commit message sync di bare repo',
    );

    // Alert hijau + tombol sync di halaman projects (owner).
    const page = await req(ctx.port, 'GET', '/projects', { jar: ctx.ownerJar });
    const text = await page.text();
    assert.ok(text.includes('<section class="card" id="github-sync">'), 'kartu GitHub Sync tampil');
    assert.ok(text.includes('Sync berhasil — 1 project ter-commit ke GitHub'), 'alert hijau sukses');
    assert.ok(text.includes('action="/projects/sync-to-github"'), 'tombol sync POST ke endpoint');
    assert.ok(text.includes('data-confirm="Commit projects.auto.json ke GitHub?"'), 'confirm dialog');
    // Badge: tepat 1 project (dengan repo_url, ada di manifest) → synced hijau;
    // tidak ada badge 'lokal' (tidak ada repo_url yang belum di-sync).
    assert.ok(text.includes('badge badge--ok">synced'), 'badge synced (hijau) untuk project dengan repo_url');
    const syncedCount = (text.match(/>synced<\/span>/g) ?? []).length;
    assert.equal(syncedCount, 1, 'tepat 1 badge synced');
    assert.ok(!text.includes('>lokal</span>'), 'tanpa badge lokal (semua repo_url sudah synced)');
  });

  test('(6) viewer + operator → POST sync → 403 (khusus owner)', async () => {
    const perm = ctx.panel.auth.perm;
    const mkUser = async (username, role, password) => {
      const created = perm.createUser({ username, role });
      perm.approveUser(created.userId, ctx.panel.auth.listUsers()[0].userId);
      ctx.panel.auth.setPassword(username, password);
      const codes = ctx.panel.auth.issueRecoveryCodes(username);
      const jar = new Map();
      const login = await req(ctx.port, 'POST', '/login', {
        jar,
        body: form({ username, password, recoveryCode: codes[0] }),
      });
      assert.equal(login.status, 302, `${role} login sukses`);
      return jar;
    };
    const jarViewer = await mkUser('gh-peeker', 'viewer', 'viewerpass123');
    const jarOperator = await mkUser('gh-operator', 'operator', 'operatorpass123');

    for (const jar of [jarViewer, jarOperator]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await req(ctx.port, 'POST', '/projects/sync-to-github', {
        jar,
        headers: { 'x-csrf-token': jar.get('vpanel_csrf') },
        body: form({}),
      });
      assert.equal(res.status, 403, 'sync ditolak untuk non-owner');
      // eslint-disable-next-line no-await-in-loop
      const page = await req(ctx.port, 'GET', '/projects', { jar });
      const t = await page.text();
      // NB: komentar VARS template juga memuat 'id="github-sync"' → asersi
      // pada elemen section asli, bukan string mentah.
      assert.ok(!t.includes('<section class="card" id="github-sync">'), 'kartu GitHub Sync tidak tampil untuk non-owner');
      assert.ok(!t.includes('/projects/sync-to-github"'), 'tidak ada form sync untuk non-owner');
    }
  });

  test('(7) POST sync tanpa CSRF → 403', async () => {
    const res = await req(ctx.port, 'POST', '/projects/sync-to-github', {
      jar: ctx.ownerJar,
      body: form({}),
    });
    assert.equal(res.status, 403);
  });
});
