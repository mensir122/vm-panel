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
