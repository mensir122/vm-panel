// tests/unit/system-github.test.js — GET /system/github end-to-end.
// Manager nyata via start() di sandbox (port acak) — pola system-specs.test.js.
// Route membaca GitHub REST API publik (default mensir122/vm-panel): TIDAK
// bergantung internet — offline / rate-limit / 404 → available:false juga
// lulus (fail-soft, JANGAN PERNAH 500). Cache in-memory 60 detik → dua fetch
// beruntun menghasilkan fetchedAt identik.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Manager } from '../../manager/index.js';

// 'Connection: close' — pola anti-race Windows (lihat system-specs.test.js):
// socket ditutup per respons agar --test-force-exit tidak menabrak koneksi
// pooled undici yang sedang ditutup.
const H = (t) => ({ Authorization: `Bearer ${t}`, Connection: 'close' });

function randomHighPort() {
  // 20000-29999 — hindari bentrok layanan dev
  return 20000 + Math.floor(Math.random() * 10000);
}

let dir;
let manager;
let base;
let token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vmpanel-sygithub-'));
  for (let attempt = 0; attempt < 5; attempt++) {
    manager = new Manager({
      rootDir: dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'test-token-github-0123456789abcdef',
    });
    try {
      await manager.start();
      break;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  base = `http://127.0.0.1:${manager.api.port}`;
  token = manager.token;
});

after(async () => {
  if (manager && manager.running) await manager.stop();
  rmSync(dir, { recursive: true, force: true });
  // Beri waktu handle libuv (undici/sqlite) menyelesaikan transisi close —
  // pola anti-race Windows yang sama dengan system-specs.test.js.
  await delay(250);
});

const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** Shape run GitHub: {runId, status, conclusion, createdAt, url}. */
function assertRunShape(run, label) {
  assert.ok(run && typeof run === 'object', `${label} object`);
  assert.ok(Number.isInteger(run.runId) && run.runId > 0, `${label}.runId integer > 0`);
  assert.ok(typeof run.status === 'string' && run.status.length > 0, `${label}.status string`);
  assert.ok(run.conclusion === null || typeof run.conclusion === 'string', `${label}.conclusion null|string`);
  assert.ok(isIso(run.createdAt), `${label}.createdAt ISO`);
  assert.ok(typeof run.url === 'string' && /^https:\/\//.test(run.url), `${label}.url https`);
}

describe('GET /system/github', () => {
  test('tanpa token → 401', async () => {
    const r = await fetch(`${base}/system/github`, { headers: { Connection: 'close' } });
    assert.equal(r.status, 401);
    await r.text();
  });

  test('dengan token → 200 + shape {available, activeRun, lastRun, specs, fetchedAt}; offline → available:false tetap lulus', async () => {
    const r = await fetch(`${base}/system/github`, { headers: H(token) });
    assert.equal(r.status, 200, 'JANGAN PERNAH 500 walau GitHub gagal');
    const b = await r.json();

    assert.equal(typeof b.available, 'boolean', 'available boolean');
    assert.ok(isIso(b.fetchedAt), 'fetchedAt ISO');

    if (b.available === true) {
      // Online (repo publik): shape lengkap.
      assert.ok('activeRun' in b && 'lastRun' in b && 'specs' in b, 'kunci run/specs lengkap');
      if (b.activeRun !== null) assertRunShape(b.activeRun, 'activeRun');
      if (b.lastRun !== null) {
        assertRunShape(b.lastRun, 'lastRun');
        assert.ok(b.lastRun.conclusion !== null, 'lastRun.conclusion terisi');
      }
      // specs: null (branch 'state'/file belum ada) ATAU object hasil parse JSON.
      assert.ok(
        b.specs === null || (typeof b.specs === 'object' && !Array.isArray(b.specs)),
        'specs null|object',
      );
    } else {
      // Offline / rate-limit / repo tak ditemukan → {available:false, reason, fetchedAt}.
      assert.ok(typeof b.reason === 'string' && b.reason.length > 0, 'reason string saat gagal');
    }
  });

  test('dua fetch beruntun → fetchedAt sama (cache 60 detik)', async () => {
    const r1 = await fetch(`${base}/system/github`, { headers: H(token) });
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    const r2 = await fetch(`${base}/system/github`, { headers: H(token) });
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.equal(b1.fetchedAt, b2.fetchedAt, 'cache in-memory: fetchedAt identik');
  });
});
