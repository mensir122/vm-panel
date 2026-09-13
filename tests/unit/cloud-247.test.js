// tests/unit/cloud-247.test.js — Lane L3 "One-Click 24/7" sisi panel.
//
// Git NYATA (pola github-sync.test.js): sandbox rootDir = repo git dengan
// remote origin = bare repo lokal. TIDAK ada network ke github.com:
// GITHUB_REPO diarahke ke repo fiktif supaya status runner fail-soft
// (available:false) dan badge deterministik.
//
// Skenario:
//   (setup)  VPANEL_MASTER_KEY + Manager + PanelServer sandbox + repo git
//            + bare origin + branch main ter-push + bootstrap owner + login
//   (1)      badge jujur: project TANPA repo_url → data-cloud-state="belum-cloud"
//   (2)      deploy-cloud-247 tanpa repo git → 400 + steps[0] failed + manifest
//            tidak berubah + publish TIDAK pernah dijalankan
//   (3)      deploy-cloud-247 dengan env-ref menggantung (rahasia tak ada di
//            Brankas) → 400 + sebab disebut + manifest tidak berubah
//   (4)      deploy-cloud-247 happy (validasi → manifest → push main) →
//            JSON {steps, next:'publish-state'}; manifest ter-push ke origin
//            bare dengan repo_url BERSIH (kredensial dibuang); publish-state
//            tetap berstatus 'pending' (tidak pernah otomatis dieksekusi)
//   (5)      badge jujur list: project ter-daftar + ter-push → BUKAN
//            belum-cloud/belum-terpush (runner fail-soft → 'queued')
//   (6)      publish-state FASE 1 → halaman konfirmasi (ringkasan backup lokal
//            vs commit branch state + risiko), TIDAK ada perubahan branch state
//   (7)      publish-state token palsu → 403 dan branch state tidak berubah
//   (8)      publish-state happy: token fase-1 → fase-2 → 302; branch 'state'
//            ada di bare origin berisi vm-state.enc (magic VPSTATE1 + fp),
//            runtime/vm-state-publish.enc dibuat, runtime/vm-state.enc LAMA
//            tidak tersentuh, dan TIDAK ADA nilai secret/master key bocor
//   (9)      non-fast-forward → 409 'rantai lebih baru' bila branch 'state'
//            bergerak setelah konfirmasi (kunci optimistik), tanpa force push
//   (10)     badge detail project menampilkan chip + form one-click (owner)
//            dan tanpa kartu untuk non-owner
//   (11)     non-owner (viewer/operator) → 403 untuk kedua rute; CSRF hilang → 403
//
// Regression guard: tidak ada tag {{...}} mentah di /projects & detail project
// (kontrak AGENTS §3 — template engine tidak menghapus tag tanpa key).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Manager } from '../../manager/index.js';
import { PanelServer } from '../../panel/server/index.js';
import { ManagerClient } from '../../lib/api-client.js';
import { totpGenerate } from '../../lib/crypto.js';

const execFileP = promisify(execFile);

const MASTER_KEY = 'unit-test-master-key-32chars-ok';
const SECRET_VALUE = 'super-rahasia-telegram-bot-token';

function randomHighPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

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
  if (body !== null && !h['content-type']) h['content-type'] = 'application/x-www-form-urlencoded';
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

let gitAvailable = false;
try {
  await execFileP(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { timeout: 10000 });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

const ctx = {};

/** `git <args>` di repo sandbox. */
async function git(args, cwd = ctx.dir) {
  return execFileP(process.platform === 'win32' ? 'git.exe' : 'git', args, {
    cwd,
    timeout: 60000,
    windowsHide: true,
    encoding: 'utf8',
  });
}

/** sha branch di bare origin ('' bila belum ada). */
async function remoteSha(branch) {
  try {
    const { stdout } = await git(['ls-remote', ctx.bare, `refs/heads/${branch}`], ctx.remoteDir);
    const first = String(stdout).trim().split(/\r?\n/)[0] ?? '';
    const sha = first.split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

before(async () => {
  // GITHUB_REPO fiktif → GET /system/github fail-soft (available:false) sehingga
  // badge tidak bergantung pada jaringan; VPANEL_MASTER_KEY untuk vault + encrypt.
  process.env.VPANEL_MASTER_KEY = MASTER_KEY;
  process.env.GITHUB_REPO = 'vmpanel-unit-test/repo-this-does-not-exist';

  ctx.dir = mkdtempSync(join(tmpdir(), 'vmpanel-cloud247-'));
  mkdirSync(join(ctx.dir, 'logs', 'projects'), { recursive: true });
  mkdirSync(join(ctx.dir, 'runtime'), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    ctx.manager = new Manager({
      rootDir: ctx.dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'cloud247-manager-token-0123456789abcdef',
    });
    try {
      await ctx.manager.start();
      break;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  ctx.panelData = mkdtempSync(join(tmpdir(), 'vmpanel-cloud247-panel-'));
  ctx.remoteDir = mkdtempSync(join(tmpdir(), 'vmpanel-cloud247-remote-'));
  ctx.bare = join(ctx.remoteDir, 'origin.git');
  ctx.managerClient = new ManagerClient({ port: ctx.manager.api.port, token: ctx.manager.token });
  ctx.panel = new PanelServer({
    rootDir: ctx.dir,
    dataDir: ctx.panelData,
    config: {
      panel: { port: 0, ratePerMin: 100000, loginRatePerMin: 100000 },
      manager: { apiPort: ctx.manager.api.port },
    },
    managerClient: ctx.managerClient,
    auditManager: ctx.manager.auditManager,
  });
  await ctx.panel.start();
  ctx.port = ctx.panel.port;

  // (a) repo kerja panel = sandbox rootDir, branch main, origin = bare lokal.
  const opts = { cwd: ctx.dir, timeout: 60000, windowsHide: true };
  await execFileP('git', ['init'], opts);
  await execFileP('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], opts);
  await execFileP('git', ['config', 'user.email', 'test@example.local'], opts);
  await execFileP('git', ['config', 'user.name', 'VM Panel Test'], opts);
  await execFileP('git', ['init', '--bare', ctx.bare], { timeout: 60000, windowsHide: true });
  await execFileP('git', ['--git-dir=' + ctx.bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
    timeout: 60000,
    windowsHide: true,
  });
  writeFileSync(join(ctx.dir, 'README.md'), '# cloud247 fixture\n', 'utf8');
  // .gitignore cermin repo asli: runtime/ TIDAK pernah mengotori working tree.
  writeFileSync(
    join(ctx.dir, '.gitignore'),
    'runtime/\ndata/\nbackups/\nlogs/\nworkspaces/\n*.tmp-*\n.env\nsecrets/vault.enc\n',
    'utf8',
  );
  await execFileP('git', ['add', 'README.md', '.gitignore'], opts);
  await execFileP('git', ['commit', '-m', 'fixture'], opts);
  await execFileP('git', ['remote', 'add', 'origin', ctx.bare], opts);
  await execFileP('git', ['push', 'origin', 'main'], opts);

  // (b) workspace project (path lokal — manager hanya butuh folder ada).
  ctx.wsDir = join(ctx.dir, 'workspaces', 'cloud-demo');
  mkdirSync(ctx.wsDir, { recursive: true });
  writeFileSync(join(ctx.wsDir, 'index.html'), '<!doctype html><body>demo</body>\n', 'utf8');

  // (c) login owner
  const jar = new Map();
  const boot = await req(ctx.port, 'GET', '/bootstrap', { jar });
  const bootToken = String((await boot.text()).match(/name="token" value="([0-9a-f]+)"/)?.[1] ?? '');
  const bootRes = await req(ctx.port, 'POST', '/bootstrap', {
    jar,
    body: form({ token: bootToken, username: 'admin', password: 'ownerpass123', confirm: 'ownerpass123' }),
  });
  const secret = (await bootRes.text()).match(/id="bootstrap-totp"[^>]*>([A-Z2-7]+)</)?.[1];
  assert.ok(secret, 'TOTP secret owner');
  const login = await req(ctx.port, 'POST', '/login', {
    jar,
    body: form({ username: 'admin', password: 'ownerpass123', totp: totpGenerate(secret) }),
  });
  assert.equal(login.status, 302);
  ctx.ownerJar = jar;
});

after(async () => {
  if (ctx.panel) await ctx.panel.close();
  if (ctx.manager && ctx.manager.running) await ctx.manager.stop();
  delete process.env.VPANEL_MASTER_KEY;
  delete process.env.GITHUB_REPO;
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

/** Header CSRF + cookie untuk POST form. */
function csrfHeaders(jar) {
  return { 'x-csrf-token': jar.get('vpanel_csrf') };
}

function readManifest() {
  try {
    const list = JSON.parse(readFileSync(join(ctx.dir, 'projects.auto.json'), 'utf8'));
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

describe('cloud-247 (one-click panel → branch state + badge jujur)', () => {
  test('(setup) project tanpa repo + project dengan repo_url berkredensial', async () => {
    const mk = async (spec) => {
      const res = await req(ctx.port, 'POST', '/projects', {
        jar: ctx.ownerJar,
        headers: csrfHeaders(ctx.ownerJar),
        body: form(spec),
      });
      assert.equal(res.status, 302, `create ${spec.name} → redirect: ${(await res.text()).match(/role="alert">([^<]*)/)?.[1] ?? ''}`);
      return String(res.headers.get('location') ?? '').split('/').pop();
    };
    ctx.noRepoId = await mk({ name: 'cloud-norepo', type: 'static' });
    // kredensial di URL → wajib hilang di manifest (repo PUBLIC — nilai tak pernah ke main)
    ctx.demoId = await mk({
      name: 'cloud-demo',
      type: 'static',
      repo_url: 'https://oauth:ghp_SECRETTOK@github.com/example/cloud-demo.git',
    });
    assert.match(ctx.noRepoId, /^prj_/);
    assert.match(ctx.demoId, /^prj_/);
    const vaultInit = await ctx.managerClient.request('POST', '/secrets/init', { body: {} });
    assert.equal(vaultInit.initialized, true, 'Brankas siap (metadata secret untuk validasi cloud)');
  });

  test('(1) badge jujur: project belum masuk manifest → belum-cloud', { skip: !gitAvailable }, async () => {
    const res = await req(ctx.port, 'GET', '/projects', { jar: ctx.ownerJar });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('{{'), 'tidak ada tag template mentah');
    const states = [...text.matchAll(/data-cloud-state="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(states.length >= 2, `satu chip per baris (dapat ${states.length})`);
    assert.ok(states.every((s) => s === 'belum-cloud'), `semua belum-cloud (dapat ${states.join(',')})`);
  });

  test('(2) deploy-cloud-247 TANPA repo git → 400 + manifest tidak berubah', { skip: !gitAvailable }, async () => {
    const before = readManifest();
    const res = await req(ctx.port, 'POST', `/projects/${ctx.noRepoId}/deploy-cloud-247`, {
      jar: ctx.ownerJar,
      headers: { ...csrfHeaders(ctx.ownerJar), accept: 'application/json' },
      body: form({}),
    });
    assert.equal(res.status, 400, 'validasi gagal → 400');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.next, 'fix-prerequisites');
    assert.ok(Array.isArray(body.steps) && body.steps.length >= 3, 'steps [{' + (body.steps ?? []).length + '}]');
    const first = body.steps[0];
    assert.equal(first.name, 'validasi');
    assert.equal(first.status, 'failed');
    assert.match(first.detail, /repo/i, 'sebab disebut: butuh repo git');
    assert.deepEqual(readManifest(), before, 'manifest tidak disentuh saat validasi gagal');
  });

  test('(3) deploy-cloud-247 dengan env-ref menggantung → 400 + sebab', { skip: !gitAvailable }, async () => {
    await ctx.managerClient.request('POST', `/projects/${ctx.demoId}/env`, {
      body: { envName: 'BOT_TOKEN', secretName: 'token_yang_tidak_ada_di_brankas' },
    });
    const res = await req(ctx.port, 'POST', `/projects/${ctx.demoId}/deploy-cloud-247`, {
      jar: ctx.ownerJar,
      headers: { ...csrfHeaders(ctx.ownerJar), accept: 'application/json' },
      body: form({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.steps[0].status, 'failed');
    assert.match(body.steps[0].detail, /BOT_TOKEN/, 'menyebut envName yang bermasalah');
    assert.match(body.steps[0].detail, /Brankas|rahasia/i, 'menyebut sebab: rahasia tidak ada di Brankas');
    const list = readManifest();
    assert.ok(!list || !list.some((e) => e.name === 'cloud-demo'), 'project rusak tidak masuk manifest');
  });

  test('(4) deploy-cloud-247 happy A-C → steps + next publish-state; manifest ter-push bersih', { skip: !gitAvailable }, async () => {
    // benerin binding: rahasia ADA di Brankas (nilai hanya lewat vault, tidak pernah ke respons)
    await ctx.manager.secretManager.setSecret({ name: 'telegram_bot_token', value: SECRET_VALUE });
    await ctx.managerClient.request('POST', `/projects/${ctx.demoId}/env`, {
      body: { envName: 'BOT_TOKEN', secretName: 'telegram_bot_token' },
    });

    const res = await req(ctx.port, 'POST', `/projects/${ctx.demoId}/deploy-cloud-247`, {
      jar: ctx.ownerJar,
      headers: { ...csrfHeaders(ctx.ownerJar), accept: 'application/json' },
      body: form({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body.steps));
    assert.equal(body.next, 'publish-state');
    assert.equal(body.publishAction, '/projects/publish-state');
    const byName = Object.fromEntries(body.steps.map((s) => [s.name, s.status]));
    assert.equal(byName.validasi, 'ok');
    assert.equal(byName.manifest, 'ok');
    assert.equal(byName['push-main'], 'ok');
    assert.equal(byName['publish-state'], 'pending', 'publish TIDAK otomatis jalan (butuh konfirmasi dua fase)');
    assert.ok(!JSON.stringify(body).includes(SECRET_VALUE), 'nilai secret tidak pernah masuk respons');
    assert.ok(!JSON.stringify(body).includes('ghp_SECRETTOK'), 'kredensial URL tidak pernah masuk respons');

    // manifest lokal: repo_url BERSIH + enabled true
    const list = readManifest();
    const entry = list.find((e) => e.name === 'cloud-demo');
    assert.ok(entry, 'entri cloud-demo ada');
    assert.equal(entry.enabled, true);
    assert.equal(entry.repo_url, 'https://github.com/example/cloud-demo', `repo_url bersih (dapat ${entry.repo_url})`);
    assert.ok(!entry.repo_url.includes('@'), 'tanpa kredensial');

    // dan benar-benar ter-commit + ter-push ke origin bare (branch main)
    const { stdout } = await git(['--git-dir=' + ctx.bare, 'show', 'refs/heads/main:projects.auto.json']);
    const pushed = JSON.parse(stdout);
    assert.ok(pushed.some((e) => e.name === 'cloud-demo'), 'manifest di origin/main berisi cloud-demo');
  });

  test('(4b) badge jujur: manifest lokal berubah tapi belum ter-push → belum-terpush', { skip: !gitAvailable }, async () => {
    const p = join(ctx.dir, 'projects.auto.json');
    const orig = readFileSync(p, 'utf8');
    const list = JSON.parse(orig);
    list.push({ name: 'cloud-norepo', type: 'static', port: null, repo_url: 'https://github.com/example/x.git', git_branch: 'main', enabled: true });
    writeFileSync(p, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
    ctx.panel.invalidateCloudBadgeCache();
    try {
      const res = await req(ctx.port, 'GET', '/projects', { jar: ctx.ownerJar });
      const text = await res.text();
      const chips = [...text.matchAll(/data-cloud-state="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(chips.includes('belum-terpush'), `belum-terpush saat manifest dirty (dapat ${chips.join(',')})`);
    } finally {
      await git(['checkout', '--', 'projects.auto.json'], ctx.dir);
      ctx.panel.invalidateCloudBadgeCache();
    }
  });

  test('(5) badge jujur setelah push: bukan belum-cloud/belum-terpush', { skip: !gitAvailable }, async () => {
    const res = await req(ctx.port, 'GET', '/projects', { jar: ctx.ownerJar });
    const text = await res.text();
    assert.ok(!text.includes('{{'), 'tidak ada tag mentah');
    const chips = [...text.matchAll(/data-cloud-state="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(chips.includes('queued') || chips.includes('aktif') || chips.includes('gagal') || chips.includes('active'),
      `chip runner (dapat ${chips.join(',')})`);
    assert.ok(!chips.includes('belum-terpush'), 'setelah push main sukses ≠ belum-terpush');
  });

  test('(6) publish-state fase 1 → halaman konfirmasi + ringkasan, TIDAK ada push', { skip: !gitAvailable }, async () => {
    const stateBefore = await remoteSha('state');
    const res = await req(ctx.port, 'POST', '/projects/publish-state', {
      jar: ctx.ownerJar,
      headers: csrfHeaders(ctx.ownerJar),
      body: form({}),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /Konfirmasi publish state/i, 'judul konfirmasi');
    assert.match(text, /MENIMPA STATE CLOUD/, 'pesan risiko');
    assert.match(text, /Backup lokal/i, 'timestamp backup lokal ditampilkan');
    assert.match(text, /branch 'state'|state cloud/i, 'pembanding branch state ditampilkan');
    assert.match(text, /name="confirmToken"/, 'token sekali pakai');
    assert.ok(!text.includes(MASTER_KEY), 'master key tidak pernah ke response');
    assert.equal(await remoteSha('state'), stateBefore, 'fase 1 tidak mengubah branch state');
  });

  test('(7) publish-state fase 2 token palsu → 403 + branch state utuh', { skip: !gitAvailable }, async () => {
    const stateBefore = await remoteSha('state');
    const res = await req(ctx.port, 'POST', '/projects/publish-state', {
      jar: ctx.ownerJar,
      headers: csrfHeaders(ctx.ownerJar),
      body: form({ confirmToken: 'a'.repeat(64) }),
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Token konfirmasi/i);
    assert.equal(await remoteSha('state'), stateBefore, 'token palsu tidak mendorong apa pun');
  });

  test('(7b) VPANEL_MASTER_KEY absent → 502 jelas, state cloud tidak disentuh', { skip: !gitAvailable }, async () => {
    const stateBefore = await remoteSha('state');
    const saved = process.env.VPANEL_MASTER_KEY;
    delete process.env.VPANEL_MASTER_KEY;
    try {
      const phase1 = await req(ctx.port, 'POST', '/projects/publish-state', {
        jar: ctx.ownerJar,
        headers: csrfHeaders(ctx.ownerJar),
        body: form({}),
      });
      const token = String((await phase1.text()).match(/name="confirmToken" value="([0-9a-f]+)"/)?.[1] ?? '');
      const res = await req(ctx.port, 'POST', '/projects/publish-state', {
        jar: ctx.ownerJar,
        headers: csrfHeaders(ctx.ownerJar),
        body: form({ confirmToken: token }),
      });
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.match(text, /master key tidak tersedia/i, 'pesan jelas soal environment panel');
      assert.match(text, /alert--error/, 'banner error di halaman projects');
      assert.equal(await remoteSha('state'), stateBefore, 'tidak ada push saat kunci tidak ada');
    } finally {
      if (saved) process.env.VPANEL_MASTER_KEY = saved;
    }
  });

  test('(7c) jalur tanpa-JS: one-click HTML + checkbox saya-pahami → halaman konfirmasi', { skip: !gitAvailable }, async () => {
    // (a) tanpa accept json → halaman hasil (bukan JSON)
    const html = await req(ctx.port, 'POST', `/projects/${ctx.demoId}/deploy-cloud-247`, {
      jar: ctx.ownerJar,
      headers: csrfHeaders(ctx.ownerJar),
      body: form({}),
    });
    assert.equal(html.status, 200);
    const text = await html.text();
    assert.match(text, /One-Click Cloud 24\/7/, 'halaman langkah (native post)');
    assert.match(text, /push-main/, 'daftar langkah dirender server-side');
    assert.match(text, /action="\/projects\/publish-state"/, 'form dua fase publish ditawarkan, bukan dijalankan');
    assert.ok(!/name="confirmToken"/.test(text), 'konfirmasi belum issued di POST ini (tidak ada auto-execute)');

    // (b) dengan auto_publish=1 → tetap berhenti di FASE 1 (halaman konfirmasi)
    const auto = await req(ctx.port, 'POST', `/projects/${ctx.demoId}/deploy-cloud-247`, {
      jar: ctx.ownerJar,
      headers: csrfHeaders(ctx.ownerJar),
      body: form({ auto_publish: '1' }),
    });
    assert.equal(auto.status, 200);
    const autoText = await auto.text();
    assert.match(autoText, /Konfirmasi publish state/i, 'checkbox hanya mempercepat sampai halaman konfirmasi');
    assert.match(autoText, /name="confirmToken"/, 'fase 1 konfirmasi — eksekusi tetap butuh klik lagi');
  });

  test('(8) publish-state happy: backup → encrypt → push branch state (audit metadata)', { skip: !gitAvailable }, async () => {
    const phase1 = await req(ctx.port, 'POST', '/projects/publish-state', {
      jar: ctx.ownerJar,
      headers: csrfHeaders(ctx.ownerJar),
      body: form({}),
    });
    const token = String((await phase1.text()).match(/name="confirmToken" value="([0-9a-f]+)"/)?.[1] ?? '');
    assert.ok(token.length >= 32, 'token fase 1');

    const res = await req(ctx.port, 'POST', '/projects/publish-state', {
      jar: ctx.ownerJar,
      headers: csrfHeaders(ctx.ownerJar),
      body: form({ confirmToken: token }),
    });
    const text = await res.text();
    assert.equal(res.status, 302, `publish → redirect /projects (dapat ${res.status}): ${text.match(/role="alert">([^<]*)/)?.[1] ?? ''}`);
    assert.ok(!text.includes(SECRET_VALUE) && !text.includes(MASTER_KEY), 'tidak ada nilai secret di response');

    // branch state ada + isinya container terenkripsi (bukan plaintext)
    const sha = await remoteSha('state');
    assert.match(sha, /^[0-9a-f]{40}$/, 'branch state ter-push ke origin');
    const { stdout } = await git(['--git-dir=' + ctx.bare, 'show', `${sha}:vm-state.enc`]);
    const container = JSON.parse(stdout);
    assert.equal(container.magic, 'VPSTATE1', 'container state gen-2');
    assert.ok(typeof container.fp === 'string' && container.fp.length >= 8, 'fingerprint kunci di header (kontrak L2)');
    assert.ok(!stdout.includes(SECRET_VALUE), 'isi vault TIDAK pernah plaintext di branch state');

    // file lokal: publish PUNYA NAMA TERPISAH, runtime/vm-state.enc tidak disentuh
    assert.ok(existsSync(join(ctx.dir, 'runtime', 'vm-state-publish.enc')), 'runtime/vm-state-publish.enc ada');
    assert.ok(!existsSync(join(ctx.dir, 'runtime', 'vm-state.enc')), 'runtime/vm-state.enc milik restore lokal tidak dibuat/ditimpa');
    const stray = await git(['status', '--porcelain'], ctx.dir);
    assert.ok(!/\bruntime\b/.test(stray.stdout), 'working tree user tidak dikotori runtime/');

    // audit metadata-only
    const rows = ctx.manager.auditManager.list({ limit: 50 }).rows ?? [];
    const ev = rows.find((r) => r.operation === 'cloud.publish_state');
    assert.ok(ev, 'audit cloud.publish_state tercatat');
    const dump = JSON.stringify(ev);
    assert.ok(!dump.includes(SECRET_VALUE) && !dump.includes(MASTER_KEY), 'audit tanpa nilai secret');
    assert.ok(/bak_/.test(dump), 'audit menyebut backupId (referensi, bukan isi)');
  });

  test('(9) rantai lebih baru sejak konfirmasi → 409, tanpa force push', { skip: !gitAvailable }, async () => {
    const phase1 = await req(ctx.port, 'POST', '/projects/publish-state', {
      jar: ctx.ownerJar,
      headers: csrfHeaders(ctx.ownerJar),
      body: form({}),
    });
    const token = String((await phase1.text()).match(/name="confirmToken" value="([0-9a-f]+)"/)?.[1] ?? '');
    assert.ok(token.length >= 32);

    // Runner "menang": branch state bergerak setelah user mengonfirmasi.
    const clone = join(ctx.remoteDir, 'chain.git');
    await git(['clone', '--branch', 'state', ctx.bare, clone], ctx.remoteDir);
    await git(['-c', 'user.email=runner@example.local', '-c', 'user.name=Runner',
      'commit', '--allow-empty', '-m', 'state: run runner (rantai lebih baru)'], clone);
    await git(['push', 'origin', 'HEAD:refs/heads/state'], clone);
    const runnerSha = await remoteSha('state');
    assert.match(runnerSha, /^[0-9a-f]{40}$/);

    const res = await req(ctx.port, 'POST', '/projects/publish-state', {
      jar: ctx.ownerJar,
      headers: csrfHeaders(ctx.ownerJar),
      body: form({ confirmToken: token }),
    });
    assert.equal(res.status, 409, 'rantai bergerak → 409 (bukan overwrite)');
    const text = await res.text();
    assert.match(text, /rantai lebih baru/i, 'pesan jujur: tunggu cycle selesai');
    assert.equal(await remoteSha('state'), runnerSha, 'commit runner TIDAK ditimpa (no force push)');
    assert.ok(!text.includes(MASTER_KEY), 'tanpa bocor kunci di pesan error');
  });

  test('(10) detail project: chip jujur + form one-click (owner)', { skip: !gitAvailable }, async () => {
    const res = await req(ctx.port, 'GET', `/projects/${ctx.demoId}`, { jar: ctx.ownerJar });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('{{'), 'tidak ada tag mentah di detail project');
    assert.match(text, /id="cloud-247"/, 'kartu Cloud 24/7 tampil');
    assert.match(text, /data-cloud-state="/, 'chip badge tampil');
    assert.match(text, new RegExp(`action="/projects/${ctx.demoId}/deploy-cloud-247"`), 'form one-click');
    assert.match(text, /name="auto_publish"/, 'checkbox saya-pahami (tetap butuh konfirmasi publish)');
    assert.match(text, /action="\/projects\/publish-state"/, 'form publish dua fase tersedia');
  });

  test('(11) non-owner & tanpa CSRF → 403', { skip: !gitAvailable }, async () => {
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
      assert.equal(login.status, 302, `${role} login`);
      return jar;
    };
    const jarViewer = await mkUser('cloud-peeker', 'viewer', 'viewerpass123');
    const jarOperator = await mkUser('cloud-operator', 'operator', 'operatorpass123');

    for (const jar of [jarViewer, jarOperator]) {
      // eslint-disable-next-line no-await-in-loop
      const pub = await req(ctx.port, 'POST', '/projects/publish-state', {
        jar,
        headers: csrfHeaders(jar),
        body: form({}),
      });
      assert.equal(pub.status, 403, 'publish state khusus owner');
      // eslint-disable-next-line no-await-in-loop
      const dep = await req(ctx.port, 'POST', `/projects/${ctx.demoId}/deploy-cloud-247`, {
        jar,
        headers: csrfHeaders(jar),
        body: form({}),
      });
      assert.equal(dep.status, 403, 'one-click cloud khusus owner');
      // eslint-disable-next-line no-await-in-loop
      const page = await req(ctx.port, 'GET', `/projects/${ctx.demoId}`, { jar });
      const t = await page.text();
      assert.ok(!/id="cloud247-form"/.test(t), 'form one-click tidak dirender untuk non-owner');
    }

    const noCsrf = await req(ctx.port, 'POST', '/projects/publish-state', {
      jar: ctx.ownerJar,
      body: form({}),
    });
    assert.equal(noCsrf.status, 403, 'CSRF wajib untuk publish state');
    const noCsrf2 = await req(ctx.port, 'POST', `/projects/${ctx.demoId}/deploy-cloud-247`, {
      jar: ctx.ownerJar,
      body: form({}),
    });
    assert.equal(noCsrf2.status, 403, 'CSRF wajib untuk one-click');
  });
});
