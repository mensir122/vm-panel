// tests/unit/workflows.test.js — validasi statis workflow + scripts (tanpa eksekusi).
// POSIX-only smoke di-skip di Windows (guard bash).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(ROOT, '.github', 'workflows');
const SCRIPTS = path.join(ROOT, 'scripts');

const read = (p) => fs.readFileSync(p, 'utf8');

test('vm.yml: timeout 360, concurrency vm-chain, permissions actions write, tanpa PAT', () => {
  const s = read(path.join(WF, 'vm.yml'));
  assert.match(s, /timeout-minutes:\s*360/);
  assert.match(s, /group:\s*vm-chain/);
  assert.match(s, /cancel-in-progress:\s*false/);
  assert.match(s, /actions:\s*write/);
  assert.match(s, /workflow_dispatch/);
  // Tanpa PAT hardcoded (ghp_/github_pat_).
  assert.ok(!/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(s), 'vm.yml tidak boleh berisi PAT');
  assert.ok(!/password|api_key|secret_key/.test(s.toLowerCase().replace('secrets.', '').replace('vpanel_master_key', '')), 'tidak ada nilai secret literal');
});

test('recovery.yml: cron 15 menit + dispatch + issue alert', () => {
  const s = read(path.join(WF, 'recovery.yml'));
  assert.match(s, /cron:\s*'?\*\/15 \* \* \* \*'?/);
  assert.match(s, /workflow_dispatch/);
  assert.match(s, /gh workflow run vm\.yml/);
  assert.match(s, /issues:\s*write/);
  assert.ok(!/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(s));
});

test('ci.yml: npm test + node --check + permissions read-only', () => {
  const s = read(path.join(WF, 'ci.yml'));
  assert.match(s, /npm run test:unit/);
  assert.match(s, /node --check/);
  assert.match(s, /contents:\s*read/);
  assert.ok(!/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(s));
});

test('semua script yang direferensikan vm.yml ada', () => {
  const s = read(path.join(WF, 'vm.yml'));
  const refs = [...s.matchAll(/scripts\/([a-z_]+\.sh)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5, `vm.yml harus memanggil beberapa script (dapat: ${refs.join(',')})`);
  for (const r of new Set(refs)) {
    assert.ok(fs.existsSync(path.join(SCRIPTS, r)), `script ${r} harus ada`);
  }
});

test('semua script .sh: set -euo pipefail + prefix log + tanpa secret literal', () => {
  const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'));
  assert.ok(files.length >= 8, `minimal 8 script (dapat ${files.length})`);
  for (const f of files) {
    const s = read(path.join(SCRIPTS, f));
    assert.match(s, /set -euo pipefail/, `${f}: set -euo pipefail wajib`);
    assert.ok(!/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(s), `${f}: tanpa PAT`);
    assert.ok(!/(password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(s.replace(/\$\{[^}]+\}/g, '')), `${f}: tanpa nilai secret literal`);
    if (f !== 'bootstrap.sh') {
      assert.match(s, /\[.{2,20}\]/, `${f}: log prefix [script]`);
    }
  }
});

test('keepalive.sh: sisa waktu dari job started_at (bukan Date.now) + drain + dispatch', () => {
  const s = read(path.join(SCRIPTS, 'keepalive.sh'));
  assert.match(s, /started_at/);
  assert.match(s, /gh api/);
  assert.match(s, /DRAIN_MIN/);
  assert.match(s, /gh workflow run vm\.yml/);
  assert.match(s, /chain-lock\.json/);
  assert.match(s, /expires_at/);
});

// --- Regresi F9: heartbeat chain-lock + retry dispatch + drain polling nyata ---
test('keepalive.sh F9: chain-lock ditulis ULANG tiap loop (expires_at = now + TTL)', () => {
  const s = read(path.join(SCRIPTS, 'keepalive.sh'));
  // Helper heartbeat ada dan DIPANGGIL lebih dari sekali (loop utama, drain,
  // tunggu run baru) — satu kali saja = bug lama (lock ditulis sekali di awal).
  assert.match(s, /write_chain_lock\(\)\s*\{/, 'helper write_chain_lock wajib ada');
  const calls = [...s.matchAll(/\$\(write_chain_lock\)/g)].length;
  assert.ok(calls >= 3, `write_chain_lock harus dipanggil >=3x (dapat ${calls})`);
  // expires_at = now + TTL 4 menit (240s), format ISO UTC dengan suffix 'Z'.
  assert.match(s, /CHAIN_LOCK_TTL_SEC=.*240/, 'TTL chain-lock default 240s (4 menit)');
  assert.match(s, /exp_s=\$\(\( now_s \+ CHAIN_LOCK_TTL_SEC \)\)/, 'expires_at = now + TTL');
  assert.match(
    s,
    /exp_iso=\$\(date -u -d "@\$\{exp_s\}" \+%Y-%m-%dT%H:%M:%SZ\)/,
    'ISO UTC dengan suffix Z',
  );
  assert.match(s, /"expires_at": "\$\{exp_iso\}"/, 'field expires_at terisi expiry heartbeat');
});

test('keepalive.sh F9: dispatch gh workflow run dibungkus retry (3x, backoff)', () => {
  const s = read(path.join(SCRIPTS, 'keepalive.sh'));
  assert.match(s, /retry_gh\(\)\s*\{/, 'helper retry_gh wajib ada');
  assert.match(s, /DISPATCH_ATTEMPTS=.*:-3/, 'default 3 percobaan');
  assert.match(s, /DISPATCH_BACKOFF_SEC=.*:-\d+/, 'backoff awal terkonfigurasi');
  assert.match(s, /delay=\$\(\( delay \* 2 \)\)/, 'backoff eksponensial (x2)');
  // Dispatch harus lewat retry_gh, bukan panggilan gh telanjang.
  assert.match(
    s,
    /retry_gh[^\n]*(?:\\\n[^\n]*)?gh workflow run vm\.yml/,
    'dispatch harus dibungkus retry_gh',
  );
});

test('keepalive.sh F9/#39: drain = polling nyata antrean, bukan sleep buta; deadline -> skip bukan gagal', () => {
  const s = read(path.join(SCRIPTS, 'keepalive.sh'));
  assert.ok(!/\bsleep 60\b/.test(s), 'drain sleep 60 buta harus hilang');
  assert.match(s, /queue_busy_count\(\)\s*\{/, 'helper queue_busy_count wajib ada');
  // Polling memakai API manager lokal.
  assert.match(s, /\/deployments\?status=running/, 'polling deployment running');
  assert.match(s, /\/recovery\/status/, 'polling recovery status');
  assert.match(s, /DRAIN_POLL_SEC/, 'interval polling terkonfigurasi');
  assert.match(s, /DRAIN_DEADLINE=/, 'deadline drain ada');
  // Deadline tercapai = lanjut chain (bukan exit 1) -> tidak ada `exit 1` di blok drain.
  const drainBlock = s.slice(s.indexOf('# --- drain:'), s.indexOf('# --- VAULT BRANCH'));
  assert.ok(drainBlock, 'blok drain harus ada');
  assert.ok(!/exit 1/.test(drainBlock), 'deadline drain tidak boleh menggagalkan run (skip)');
  assert.match(drainBlock, /lanjut chain/, 'pesan deadline: lanjut chain');
});

// --- Regresi F9: guard verifikasi backup_final ---
test('backup_final.sh F9: guard verifikasi gagal harus exit (bukan silent-failure)', () => {
  const s = read(path.join(SCRIPTS, 'backup_final.sh'));
  assert.match(s, /if \(!v\.ok\)\s*\{/, 'guard wajib `if (!v.ok) {`');
  assert.ok(
    !/verification_status !== undefined/.test(s),
    'guard lama `v.verification_status !== undefined` selalu false = bug silent-failure',
  );
  assert.match(s, /console\.error\(/, 'error dicetak sebelum exit');
  assert.match(s, /process\.exit\(1\)/, 'verifikasi gagal -> exit 1');
  // Exit harus terjadi SEBELUM backupId dicetak (dipakai step berikutnya).
  assert.ok(
    s.indexOf('process.exit(1)') < s.indexOf('console.log(res.backupId)'),
    'exit 1 harus sebelum pencetakan backupId',
  );
});

// --- Regresi F10: recovery.yml ---
test('recovery.yml F10: parsing expiry pakai node Date.parse (bukan python fromisoformat)', () => {
  const s = read(path.join(WF, 'recovery.yml'));
  assert.ok(!/fromisoformat/.test(s), 'python fromisoformat gagal pada suffix Z di py<3.11');
  assert.ok(!/python3?/.test(s), 'step expiry tidak boleh lagi memakai python');
  assert.match(s, /Date\.parse\(/, 'pakai node Date.parse');
  assert.match(s, /chain-lock\.json/, 'masih membaca chain-lock.json dari artifact');
});

test('recovery.yml F10: queued dihitung sibuk + rule dispatch conclusion!=success, rule expiry tetap ada', () => {
  const s = read(path.join(WF, 'recovery.yml'));
  assert.match(s, /status=queued/, 'queued dihitung sebagai run sibuk');
  assert.match(s, /busy=\$\(\( IN_PROGRESS \+ QUEUED \)\)/, 'busy = in_progress + queued');
  assert.match(s, /steps\.active\.outputs\.busy == '0'/, 'gate dispatch memakai busy, bukan in_progress saja');
  // Rule baru: run terakhir conclusion != success.
  assert.match(s, /conclusion/, 'cek conclusion run terakhir');
  assert.match(s, /!= "success"/, 'conclusion != success -> chain putus');
  assert.match(s, /broken=true/, 'output rule broken');
  // Rule lama (expiry) TIDAK boleh hilang; keduanya di-OR.
  assert.match(s, /expired=true/, 'rule expiry chain-lock tetap ada');
  assert.match(s, /steps\.lock\.outputs\.expired == 'true' \|\| steps\.last\.outputs\.broken == 'true'/,
    'dispatch = expired ATAU conclusion != success');
});

// --- Regresi #40: ci.yml memeriksa .mjs juga ---
test('ci.yml: node --check juga memindai *.mjs', () => {
  const s = read(path.join(WF, 'ci.yml'));
  assert.match(s, /-name '\*\.mjs'/, "find harus menyertakan -name '*.mjs'");
  assert.match(s, /node --check/);
});

test('stop_all.sh: graceful (SIGTERM dulu, SIGKILL kemudian)', () => {
  const s = read(path.join(SCRIPTS, 'stop_all.sh'));
  const sigterm = s.indexOf('kill "$PID"');
  const sigkill = s.indexOf('kill -9');
  assert.ok(sigterm >= 0 && sigkill > sigterm, 'SIGTERM harus sebelum SIGKILL');
});

// POSIX-only smoke: jalankan verify_state.sh di sandbox (skip di Windows).
const isPosix = process.platform !== 'win32' && fs.existsSync('/usr/bin/bash');
test('smoke: verify_state.sh di sandbox (POSIX only)', { skip: !isPosix }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-smoke-'));
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
  const r = spawnSync('bash', [path.join(SCRIPTS, 'verify_state.sh')], {
    encoding: 'utf8', cwd: ROOT, timeout: 60000,
    env: { ...process.env },
  });
  // Script exit 0 walau tidak ada DB (semua di-skip).
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
});
