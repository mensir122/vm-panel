// tests/unit/internal-supervisor.test.js — InternalSupervisor (DESIGN.md §8.1-8.3, §8.5).
// Sandbox penuh: FAKE ServiceManager + FAKE processManager in-memory,
// HealthManager NYATA di tmp dataDir, clock di-inject, lock di tmp dir.
// TIDAK meng-import manager/service_manager (modul asli) sama sekali.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { InternalSupervisor } from '../../manager/recovery_manager/index.js';
import { HealthManager } from '../../manager/health_manager/index.js';
import { acquire, release } from '../../lib/lock.js';

/* ---------------- fakes ---------------- */

/** FAKE ServiceManager in-memory — kontrak: listServices/getService/
 *  restartService/setSupervisorState/getSupervisorState/healthService. */
class FakeServiceManager {
  constructor() {
    this.services = new Map();
    this.supState = new Map();
    this.restartCalls = []; // {id, at}
    this.healthCalls = []; // {id, at}
    this.stateWrites = []; // {id, patch, at}
    this.restartImpl = null; // async (id) => hasil; default sukses
    this.healthImpl = null; // async (id, hm) => {ok, ...}
    this._now = () => Date.now();
  }
  addService(row) {
    this.services.set(row.service_id, {
      service_id: row.service_id,
      project_id: 'prj-1',
      status: 'running',
      pid: 1111,
      enabled: 1,
      config: {},
      restart_policy: { mode: 'on-failure' },
      ...row,
    });
  }
  listServices() {
    return [...this.services.values()];
  }
  getService(id) {
    return this.services.get(id) ?? null;
  }
  async restartService(id) {
    this.restartCalls.push({ id, at: this._now() });
    if (this.restartImpl) return this.restartImpl(id);
    return { pid: 9000 + this.restartCalls.length };
  }
  setSupervisorState(id, patch) {
    const cur = this.supState.get(id) ?? {};
    const next = { ...cur, ...patch };
    this.supState.set(id, next);
    this.stateWrites.push({ id, patch, at: this._now() });
    return next;
  }
  getSupervisorState(id) {
    return this.supState.get(id) ?? null;
  }
  async healthService(id /*, healthManager */) {
    this.healthCalls.push({ id, at: this._now() });
    if (this.healthImpl) return this.healthImpl(id);
    return { ok: true, consecutiveFailures: 0 };
  }
}

/** FAKE processManager — isAlive programmable + exit record manual. */
class FakeProcessManager {
  constructor() {
    this.aliveImpl = () => false;
    this.exitRecords = new Map();
  }
  async isAlive(pid /*, startTimeHint */) {
    return this.aliveImpl(pid) === true;
  }
  getExitRecord(id) {
    return this.exitRecords.get(id) ?? null;
  }
}

/** Logger penangkap event untuk asersi. */
function captureLogger(nowFn) {
  const events = [];
  const mk = (level) => (msg, extra) =>
    events.push({ level, msg, extra: extra ?? null, at: nowFn() });
  return {
    events,
    logger: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') },
  };
}

/** Mock global.fetch untuk notifikasi webhook. */
function mockFetch() {
  const calls = [];
  const prev = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
  return { calls, restore: () => { global.fetch = prev; } };
}

/** Baca baris alert dari health.db NYATA. */
function alertRows(dataDir, code) {
  const db = new Database(path.join(dataDir, 'health.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db
      .prepare('SELECT level, code, message, at, resolved_at FROM alerts WHERE code = ? ORDER BY id')
      .all(code);
  } finally {
    db.close();
  }
}

/* ---------------- harness ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir;
let lockDir;
let dataDir;
let healthManager;
let nowMs;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-supervisor-'));
  lockDir = path.join(dir, 'locks');
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  nowMs = 1_700_000_000_000;
  healthManager = new HealthManager({ dataDir });
});

afterEach(() => {
  healthManager.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Rakit supervisor + fake dengan clock bersama. */
function rig({ supOpts = {}, services = [], pm, sm } = {}) {
  const serviceManager = sm ?? new FakeServiceManager();
  serviceManager._now = () => nowMs;
  for (const row of services) serviceManager.addService(row);
  const processManager = pm ?? new FakeProcessManager();
  const { events, logger } = captureLogger(() => nowMs);
  const supervisor = new InternalSupervisor({
    serviceManager,
    healthManager,
    processManager,
    logger,
    nowFn: () => nowMs,
    lockDir,
    lockWaitMs: 50,
    lockTtlMs: 5000,
    pollIntervalMs: 15,
    ...supOpts,
  });
  return { supervisor, serviceManager, processManager, events };
}

const svc = (over = {}) => ({ service_id: 'svc-1', pid: 1111, ...over });

/* ---------------- tests ---------------- */

test('mati + on-failure: tick 1 → event died + backoff terjadwal TANPA restart; setelah waktu maju → restart dipanggil', async () => {
  const { supervisor, serviceManager, processManager, events } = rig({
    services: [svc({ status: 'running', pid: 1111 })],
  });
  processManager.exitRecords.set('svc-1', { pid: 1111, exitCode: 1 });
  serviceManager.restartImpl = async () => ({ pid: 4242 });

  await supervisor.tick(); // tick 1: deteksi mati → jadwalkan backoff

  assert.equal(serviceManager.restartCalls.length, 0, 'tidak boleh langsung restart');
  const st = serviceManager.getSupervisorState('svc-1');
  assert.equal(st.state, 'recovering');
  assert.equal(st.backoffUntil, nowMs + 5000, 'delay index 0 = 5s');
  assert.equal(st.restartCount ?? 0, 0, 'restart_count tetap 0');

  const died = events.find((e) => e.msg === 'supervisor.service.died');
  assert.ok(died, 'event service.died dicatat');
  assert.equal(died.extra.exitCode, 1, 'exitCode dari getExitRecord');
  assert.ok(events.some((e) => e.msg === 'supervisor.backoff.scheduled'));

  // majukan waktu melewati backoff → tick berikutnya eksekusi restart
  nowMs += 5001;
  await supervisor.tick();

  assert.equal(serviceManager.restartCalls.length, 1, 'restart dieksekusi');
  assert.equal(serviceManager.healthCalls.length, 1, 'healthService sekali setelah restart');
  const st2 = serviceManager.getSupervisorState('svc-1');
  assert.equal(st2.state, 'running');
  assert.equal(st2.backoffUntil ?? null, null);
  assert.equal(st2.lastHealthyAt, nowMs, 'window stabil baru dimulai');
  assert.equal(st2.restartCount ?? 0, 0, 'sukses tidak menaikkan counter');
  assert.ok(events.some((e) => e.msg === 'supervisor.restart.succeeded'));
});

test('backoff sequence: restart selalu gagal → delay 5s lalu 15s lalu 30s', async () => {
  const { supervisor, serviceManager } = rig({
    supOpts: { maxRestarts: 3 },
    services: [svc({ service_id: 'svc-b', pid: 2222 })],
  });
  serviceManager.restartImpl = async () => {
    throw new Error('spawn gagal');
  };

  await supervisor.tick(); // jadwalkan index 0
  let st = serviceManager.getSupervisorState('svc-b');
  assert.equal(st.restartCount ?? 0, 0);
  assert.equal(st.backoffUntil - nowMs, 5000);

  nowMs += 5001;
  await supervisor.tick(); // attempt 1 gagal → rc=1 → 15s
  st = serviceManager.getSupervisorState('svc-b');
  assert.equal(st.restartCount, 1);
  assert.equal(st.backoffUntil - nowMs, 15000);

  nowMs += 15001;
  await supervisor.tick(); // attempt 2 gagal → rc=2 → 30s
  st = serviceManager.getSupervisorState('svc-b');
  assert.equal(st.restartCount, 2);
  assert.equal(st.backoffUntil - nowMs, 30000);
  assert.equal(serviceManager.restartCalls.length, 2);
  assert.notEqual(st.crashLoop, 1, 'belum crash loop');
});

test('restart_count mencapai maxRestarts=3 → crash_loop=1 + alert CRASH_LOOP critical + notify webhook', async () => {
  const { supervisor, serviceManager, events } = rig({
    supOpts: {
      maxRestarts: 3,
      notificationWebhook: 'http://webhook.test/hook',
    },
    services: [svc({ service_id: 'svc-cl', project_id: 'prj-X', pid: 3333 })],
  });
  serviceManager.restartImpl = async () => {
    throw new Error('spawn gagal');
  };
  const hook = mockFetch();
  try {
    await supervisor.tick(); // rc=0 → backoff 5s
    nowMs += 5001;
    await supervisor.tick(); // attempt 1 gagal → rc=1
    nowMs += 15001;
    await supervisor.tick(); // attempt 2 gagal → rc=2
    nowMs += 30001;
    await supervisor.tick(); // attempt 3 gagal → rc=3 >= max → crash loop

    const st = serviceManager.getSupervisorState('svc-cl');
    assert.equal(st.crashLoop, 1);
    assert.equal(st.state, 'crash_loop');
    assert.equal(st.status, 'failed');
    assert.equal(st.restartCount, 3);
    assert.equal(st.backoffUntil ?? null, null);
    assert.equal(serviceManager.restartCalls.length, 3);

    const alerts = alertRows(dataDir, 'CRASH_LOOP');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].level, 'critical');
    assert.equal(alerts[0].resolved_at, null);

    assert.equal(hook.calls.length, 1, 'webhook dipanggil sekali');
    assert.equal(hook.calls[0].url, 'http://webhook.test/hook');
    assert.deepEqual(hook.calls[0].body, {
      event: 'crash_loop',
      serviceId: 'svc-cl',
      projectId: 'prj-X',
    });
    assert.ok(events.some((e) => e.msg === 'supervisor.crash_loop.detected'));
  } finally {
    hook.restore();
  }
});

test('crash_loop → tick no-op; manualRetry → counter reset → restart dicoba lagi', async () => {
  const { supervisor, serviceManager } = rig({
    supOpts: { maxRestarts: 3 },
    services: [svc({ service_id: 'svc-m', pid: 4444 })],
  });
  // preset crash loop
  serviceManager.setSupervisorState('svc-m', {
    state: 'crash_loop',
    crashLoop: 1,
    restartCount: 3,
    backoffUntil: null,
  });

  const before = serviceManager.restartCalls.length;
  nowMs += 999_999;
  await supervisor.tick(); // harus no-op
  assert.equal(serviceManager.restartCalls.length, before, 'tidak ada restart saat crash loop');
  const st = serviceManager.getSupervisorState('svc-m');
  assert.equal(st.crashLoop, 1, 'state tidak berubah');

  // manual retry
  await supervisor.manualRetry('svc-m');
  let st2 = serviceManager.getSupervisorState('svc-m');
  assert.equal(st2.crashLoop, 0);
  assert.equal(st2.restartCount, 0);
  assert.equal(st2.state, 'recovering');
  assert.equal(st2.backoffUntil ?? null, null);

  // tick berikutnya → restart langsung dicoba
  serviceManager.restartImpl = async () => ({ pid: 7777 });
  await supervisor.tick();
  assert.equal(serviceManager.restartCalls.length, before + 1, 'restart dicoba lagi');
  st2 = serviceManager.getSupervisorState('svc-m');
  assert.equal(st2.state, 'running');
  assert.equal(st2.crashLoop, 0);
});

test('policy never → langsung failed tanpa restart + alert; tidak dobel alert di tick berikutnya', async () => {
  const { supervisor, serviceManager, events } = rig({
    services: [svc({ service_id: 'svc-n', pid: 5555, restart_policy: { mode: 'never' } })],
  });

  await supervisor.tick();
  const st = serviceManager.getSupervisorState('svc-n');
  assert.equal(st.state, 'failed');
  assert.equal(st.status, 'failed');
  assert.equal(st.backoffUntil ?? null, null);
  assert.equal(serviceManager.restartCalls.length, 0);
  assert.ok(events.some((e) => e.msg === 'supervisor.service.failed'));
  assert.equal(alertRows(dataDir, 'SERVICE_FAILED').length, 1);

  await supervisor.tick(); // masih mati → tetap failed, alert TIDAK dobel
  assert.equal(serviceManager.restartCalls.length, 0);
  assert.equal(alertRows(dataDir, 'SERVICE_FAILED').length, 1, 'tidak spam alert');
});

test('alive + health fail 3x → recovering + alert warning; health ok → recovered + alert resolved', async () => {
  const { supervisor, serviceManager, processManager, events } = rig({
    services: [svc({ service_id: 'svc-h', pid: 6666 })],
  });
  processManager.aliveImpl = () => true;

  let failMode = true;
  // healthService fake MENGGUNAKAN HealthManager NYATA → state asli.
  serviceManager.healthImpl = async (id) => {
    const res = healthManager.recordCheck({
      serviceId: id,
      projectId: 'prj-1',
      check: { type: 'process' },
      outcome: { ok: !failMode, latencyMs: 1 },
    });
    return { ok: !failMode, consecutiveFailures: res.consecutiveFailures, status: res.status };
  };

  await supervisor.tick(); // failures = 1
  await supervisor.tick(); // failures = 2
  let st = serviceManager.getSupervisorState('svc-h');
  assert.notEqual(st?.state, 'recovering', 'belum threshold');

  await supervisor.tick(); // failures = 3 → recovering + alert
  st = serviceManager.getSupervisorState('svc-h');
  assert.equal(st.state, 'recovering');
  let alerts = alertRows(dataDir, 'SERVICE_UNHEALTHY');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'warning');
  assert.equal(alerts[0].resolved_at, null);

  failMode = false;
  await supervisor.tick(); // sehat lagi → recovered
  st = serviceManager.getSupervisorState('svc-h');
  assert.equal(st.state, 'running');
  assert.equal(st.consecutiveFailures ?? 0, 0);
  alerts = alertRows(dataDir, 'SERVICE_UNHEALTHY');
  assert.equal(alerts.length, 1, 'alert tidak dobel');
  assert.notEqual(alerts[0].resolved_at, null, 'alert resolved');
  assert.ok(events.some((e) => e.msg === 'supervisor.service.recovered'));
});

test('stable window: healthy > stableWindowMs → restart_count direset; mati lagi → backoff index 0', async () => {
  const { supervisor, serviceManager, processManager } = rig({
    supOpts: { stableWindowMs: 600_000 },
    services: [svc({ service_id: 'svc-s', pid: 7777 })],
  });
  processManager.aliveImpl = () => true;
  serviceManager.setSupervisorState('svc-s', { state: 'running', restartCount: 2 });

  await supervisor.tick(); // healthy pertama → lastHealthyAt = now, rc tetap 2
  let st = serviceManager.getSupervisorState('svc-s');
  assert.equal(st.restartCount, 2, 'belum stabil 600s → tidak reset');
  assert.equal(st.lastHealthyAt, nowMs);

  nowMs += 600_001;
  await supervisor.tick(); // stabil > window → reset
  st = serviceManager.getSupervisorState('svc-s');
  assert.equal(st.restartCount, 0, 'counter direset oleh window stabil');
  assert.equal(st.lastHealthyAt, nowMs - 600_001, 'lastHealthyAt tidak digeser');

  // mati lagi → backoff dihitung dari index 0 (5s), bukan index lanjutan
  processManager.aliveImpl = () => false;
  await supervisor.tick();
  st = serviceManager.getSupervisorState('svc-s');
  assert.equal(st.backoffUntil, nowMs + 5000, 'delay kembali 5s setelah reset');
});

test('lock sudah dipegang pihak lain → tick skip tanpa error, tanpa restart/backoff', async () => {
  const { supervisor, serviceManager } = rig({
    services: [svc({ service_id: 'svc-lock', pid: 8888 })],
  });
  const token = await acquire('svc-svc-lock', { dir: lockDir, ttlMs: 10_000, maxWaitMs: 10 });
  try {
    await supervisor.tick(); // tidak boleh throw
    assert.equal(serviceManager.restartCalls.length, 0);
    const st = serviceManager.getSupervisorState('svc-lock');
    assert.equal(st?.backoffUntil ?? null, null, 'tidak ada backoff terjadwal');
  } finally {
    assert.equal(release('svc-svc-lock', token, { dir: lockDir }), true);
  }
});

test('stop() menghentikan loop (tidak ada tick lagi)', async () => {
  const { supervisor } = rig({
    services: [svc({ service_id: 'svc-t', pid: 9999 })],
  });
  supervisor.processManager.aliveImpl = () => true;
  let ticks = 0;
  const orig = supervisor.tick.bind(supervisor);
  supervisor.tick = (...a) => {
    ticks++;
    return orig(...a);
  };

  await supervisor.start();
  await sleep(100);
  supervisor.stop();
  assert.ok(ticks >= 1, 'minimal satu tick sebelum stop');
  const frozen = ticks;
  await sleep(80);
  assert.equal(ticks, frozen, 'tidak ada tick baru setelah stop');
});
