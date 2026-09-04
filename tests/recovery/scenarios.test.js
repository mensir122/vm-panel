// tests/recovery/scenarios.test.js — Failure Simulation scenarios (node:test).
// Menjalankan SUBSET skenario §19 yang bisa dijalankan di CI tanpa Actions
// nyata, dengan reuse penuh logic harness di simulate.js (import fungsi
// scenario + rig dari sana; TANPA duplikasi). Skenario yang butuh proses
// nyata berat (5, 6 — spawn manager/panel via API loopback) dijalankan juga
// di sini secara lokal (loopback fetch, process.kill — deterministik Windows).
//
// Verification requirements §19.2 per skenario: event/error tercatat, retry
// dibatasi, data valid terakhir tetap ada, tidak ada data valid terhapus.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  SCENARIOS,
  buildContext,
  runContextCleanup,
  ScenarioError,
} from './simulate.js';

const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

/** Context per test (test nested = sandbox masing-masing). */
async function withContext(fn, { timeoutMs = 120_000 } = {}) {
  const ctx = await buildContext();
  try {
    await fn(ctx);
  } finally {
    await runContextCleanup(ctx);
  }
  void timeoutMs;
}

// ── Skenario 5: manager mati + external watchdog restart ─────────────────────
// Spawn manager asli (CLI entry) di sandbox → /health 200 → SIGKILL →
// watchdog layer restart → /health 200 → row state pre-kill utuh.

test('skenario 5: manager mati (SIGKILL) → watchdog restart → /health ok + state utuh', { timeout: 150_000 }, async () => {
  await withContext(async (ctx) => {
    const detail = await byId[5].fn(ctx);
    assert.equal(typeof detail, 'string');
    assert.ok(detail.length > 0);
  });
});

// ── Skenario 6: panel mati + external watchdog restart ───────────────────────

test('skenario 6: panel mati (SIGKILL) → watchdog restart → /login ok + users.db utuh', { timeout: 150_000 }, async () => {
  await withContext(async (ctx) => {
    const detail = await byId[6].fn(ctx);
    assert.equal(typeof detail, 'string');
    assert.ok(detail.length > 0);
  });
});

// ── Skenario 19: manager mati di tengah restore → restore ulang idempotent ───

test('skenario 19: crash mid-restore 2x → restore ulang idempotent (pre-restore marker) + snapshot utuh', { timeout: 120_000 }, async () => {
  await withContext(async (ctx) => {
    const detail = await byId[19].fn(ctx);
    assert.match(detail, /idempotent/);
  });
});

// ── Skenario 20: supervisor mati mid-recovery → supervisor baru lanjut ───────
// FAKE pattern (seperti tests/unit/internal-supervisor.test.js): state DB
// disimulasikan in-memory; supervisor asli InternalSupervisor.

test('skenario 20: supervisor stop() di antara backoff → supervisor baru lanjut konsisten (recovered)', { timeout: 30_000 }, async () => {
  await withContext(async (ctx) => {
    const detail = await byId[20].fn(ctx);
    assert.match(detail, /recovered/);
  });
});

test('skenario 20b: crash-loop konsisten lintas supervisor — hasil akhir crash_loop (bukan korup)', { timeout: 30_000 }, async () => {
  await withContext(async (ctx) => {
    const { InternalSupervisor } = await import('../../manager/recovery_manager/index.js');
    const { HealthManager } = await import('../../manager/health_manager/index.js');
    let nowMs = 1_700_000_000_000;
    const health = new HealthManager({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-sim20b-')) });
    try {
      // FAKE ServiceManager/ProcessManager inline (pola internal-supervisor.test.js).
      class FakeSM {
        constructor() { this.services = new Map(); this.supState = new Map(); this.restartCalls = 0; }
        addService(row) { this.services.set(row.service_id, { status: 'running', pid: 1, enabled: 1, restart_policy: { mode: 'on-failure' }, ...row }); }
        listServices() { return [...this.services.values()]; }
        getService(id) { return this.services.get(id) ?? null; }
        async restartService() { this.restartCalls++; throw new Error('spawn gagal terus'); }
        setSupervisorState(id, patch) { const n = { ...(this.supState.get(id) ?? {}), ...patch }; this.supState.set(id, n); return n; }
        getSupervisorState(id) { return this.supState.get(id) ?? null; }
        async healthService() { return { ok: false, consecutiveFailures: 9 }; }
      }
      class FakePM {
        async isAlive() { return false; }
        getExitRecord() { return null; }
      }
      const sm = new FakeSM();
      sm.addService({ service_id: 'svc-20b', pid: 222_222 });
      const pm = new FakePM();
      const mkSup = () => new InternalSupervisor({
        serviceManager: sm, healthManager: health, processManager: pm,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        nowFn: () => nowMs, lockDir: ctx.lockDir, lockWaitMs: 50, lockTtlMs: 5000,
        pollIntervalMs: 15, maxRestarts: 3,
      });

      const sup1 = mkSup();
      await sup1.tick(); // rc=0 → backoff 5s
      nowMs += 5001; await sup1.tick(); // attempt 1 gagal → rc=1
      nowMs += 15001; await sup1.tick(); // attempt 2 gagal → rc=2
      nowMs += 30001; await sup1.tick(); // attempt 3 gagal → rc=3 >= max → crash loop
      let st = sm.getSupervisorState('svc-20b');
      assert.equal(st.crashLoop, 1, 'supervisor 1: crash loop tercapai');
      sup1.stop();

      // Manager mati; supervisor baru dengan state sama → crash_loop dipertahankan.
      const sup2 = mkSup();
      nowMs += 999_999;
      await sup2.tick(); // crash_loop → no-op (manual retry only)
      st = sm.getSupervisorState('svc-20b');
      assert.equal(st.crashLoop, 1, 'supervisor baru: crash_loop dipertahankan (state tidak korup)');
      assert.equal(st.state, 'crash_loop');
      assert.equal(sm.restartCalls, 3, 'retry dibatasi: tidak ada restart tambahan di luar batas');

      // §19.2: data valid (state terakhir yang jelas) tetap ada.
      assert.equal(typeof st.restartCount, 'number');
      assert.ok(st.updated_at == null || typeof st.updated_at === 'string');
      sup2.stop();
    } finally {
      health.close();
    }
  });
});

// ── Skenario 21: backup vs deployment konkuren → tidak deadlock ──────────────

test('skenario 21: createBackup + deploy konkuren → selesai < 60s, keduanya sukses / gagal bersih', { timeout: 90_000 }, async () => {
  await withContext(async (ctx) => {
    const detail = await byId[21].fn(ctx);
    assert.match(detail, /deadlock/);
  });
});

// ── Skenario 23: split-brain lock — dua leader, satu winner ─────────────────

test('skenario 23: dua leader proses rebutan runner.lock → tepat satu winner (LOCK_HELD untuk loser)', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const detail = await byId[23].fn(ctx);
    assert.match(detail, /1 winner/);
  });
});

// ── Skenario 24: port leak + rekonsiliasi ────────────────────────────────────

test('skenario 24: kill child manual → release-on-exit; orphan row → rekonsiliasi membersihkan', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const detail = await byId[24].fn(ctx);
    assert.match(detail, /rekonsiliasi/);
  });
});

// ── Kontrak harness: registry skenario lengkap (dokumentasi diri) ────────────

test('harness: SCENARIOS memuat 7 skenario wajib F5 Wave 1 dengan metadata lengkap', () => {
  const ids = SCENARIOS.map((s) => s.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [5, 6, 19, 20, 21, 23, 24]);
  for (const s of SCENARIOS) {
    assert.equal(typeof s.title, 'string');
    assert.ok(s.title.length > 0);
    assert.equal(typeof s.fn, 'function');
  }
});

test('harness: ScenarioError adalah Error — assertion skenario bisa dibedakan', () => {
  const e = new ScenarioError('tes');
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'tes');
});
