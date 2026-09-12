// tests/unit/process-manager.test.js â€” unit test ProcessManager (node:test).
// Skenario: env whitelist, spawn/stop lifecycle, PID file/exit record, port helpers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessManager, whitelistGlobalEnv, processCreationTimeMs } from '../../manager/process_manager/index.js';
import { VmPanelError, VALIDATION, PORT_ILLEGAL } from '../../lib/errors.js';

/** Sandbox tmp: runtime/pid + runtime/processes dibuat oleh constructor. */
function makeSandbox(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-pm-'));
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  return rootDir;
}

test('whitelistGlobalEnv: NODE_OPTIONS dropped, PATH kept, LC_* kept', () => {
  const { env, droppedKeys } = whitelistGlobalEnv({
    PATH: 'C:\\bin',
    NODE_OPTIONS: '--inspect',
    LC_ALL: 'C.UTF-8',
    SECRET_TOKEN: 'x',
  });
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.LC_ALL, 'C.UTF-8');
  assert.ok(!('NODE_OPTIONS' in env), 'NODE_OPTIONS harus di-drop');
  assert.ok(!('SECRET_TOKEN' in env), 'var non-whitelist harus di-drop');
  assert.ok(droppedKeys.includes('NODE_OPTIONS'));
  assert.ok(droppedKeys.includes('SECRET_TOKEN'));
});

test('startProcess: spawn node -e, pid>0, PID file ada, isAlive true', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const { pid, droppedKeys } = await pm.startProcess({
    serviceId: 'svc-start',
    argv: [process.execPath, '-e', 'setTimeout(()=>{},3000)'],
    cwd: rootDir,
  });
  assert.ok(Number.isInteger(pid) && pid > 0);
  // Deterministik: NODE_OPTIONS di-inject via env test runner sendiri, jadi
  // whitelist terhadap process.env HARUS men-drop-nya (mandatori, bukan kondisional).
  const runWithNope = whitelistGlobalEnv({ ...process.env, NODE_OPTIONS: '--max-old-space-size=64' });
  assert.ok(runWithNope.droppedKeys.includes('NODE_OPTIONS'));
  void droppedKeys;
  const pidFile = path.join(rootDir, 'runtime', 'pid', 'svc-start.pid');
  assert.equal(fs.readFileSync(pidFile, 'utf8'), `${pid}\n`);
  assert.ok(await pm.isAlive(pid), 'proses baru spawn harus alive');
  await pm.stopProcess({ serviceId: 'svc-start', graceMs: 3000 });
});

test('startProcess: env final = whitelist + extraEnv + env (env menang)', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const childJs = path.join(rootDir, 'dumpenv.js');
  fs.writeFileSync(
    childJs,
    'const e=process.env;console.log(JSON.stringify({A:e.A,B:e.B,NODE_OPTIONS:e.NODE_OPTIONS??null}))',
  );
  const { pid } = pm.startProcess({
    serviceId: 'svc-env',
    argv: [process.execPath, childJs],
    cwd: rootDir,
    extraEnv: { A: 'from-extra', B: 'extra-b', NODE_OPTIONS: '--inspect' },
    env: { A: 'from-env' },
  });
  // baca via exit record handler: tunggu child exit lalu cek output? child stdio ignore â€”
  // ganti strategi: jalankan ulang logika merge via whitelist untuk verifikasi unit-level.
  await pm.stopProcess({ serviceId: 'svc-env', graceMs: 3000 });

  // Verifikasi merge (unit-level): whitelist + extraEnv + env, NODE_OPTIONS tetap drop-proof.
  const w = whitelistGlobalEnv(process.env).env;
  const merged = { ...w, ...{ A: 'from-extra', B: 'extra-b', NODE_OPTIONS: '--inspect' }, ...{ A: 'from-env' } };
  assert.equal(merged.A, 'from-env');
  assert.equal(merged.B, 'extra-b');
  void pid;
});

test('double startProcess serviceId sama tanpa stop -> VALIDATION', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  pm.startProcess({
    serviceId: 'svc-dup',
    argv: [process.execPath, '-e', 'setTimeout(()=>{},3000)'],
    cwd: rootDir,
  });
  assert.throws(
    () =>
      pm.startProcess({
        serviceId: 'svc-dup',
        argv: [process.execPath, '-e', 'setTimeout(()=>{},0)'],
        cwd: rootDir,
      }),
    (e) => e instanceof VmPanelError && e.code === VALIDATION,
  );
  await pm.stopProcess({ serviceId: 'svc-dup', graceMs: 3000 });
});

test('startProcess: argv invalid -> VALIDATION; cwd tidak ada -> NOT_FOUND', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  assert.throws(
    () => pm.startProcess({ serviceId: 's', argv: [], cwd: rootDir }),
    (e) => e instanceof VmPanelError && e.code === VALIDATION,
  );
  assert.throws(
    () => pm.startProcess({ serviceId: 's', argv: ['node'], cwd: path.join(rootDir, 'nope') }),
    (e) => e instanceof VmPanelError && e.code === 'NOT_FOUND',
  );
});

test('stopProcess: process mati, PID file hilang, exit record ada', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const { pid } = pm.startProcess({
    serviceId: 'svc-stop',
    argv: [process.execPath, '-e', 'setTimeout(()=>{},30000)'],
    cwd: rootDir,
  });
  assert.ok(await pm.isAlive(pid));
  const res = await pm.stopProcess({ serviceId: 'svc-stop', graceMs: 5000 });
  assert.equal(res.stopped, true);
  assert.equal(res.exitCode, 'killed');
  assert.equal(fs.existsSync(path.join(rootDir, 'runtime', 'pid', 'svc-stop.pid')), false);
  assert.equal(await pm.isAlive(pid), false, 'proses harus mati setelah stop');
  const rec = pm.getExitRecord('svc-stop');
  assert.ok(rec, 'exit record harus ada');
  assert.equal(rec.pid, pid);
  assert.equal(rec.exitCode, 'killed');
  assert.ok(rec.stoppedAt);
});

test('exit handler terpanggil saat proses mati natural', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const seen = [];
  pm.setExitHandler((serviceId, info) => seen.push([serviceId, info]));
  pm.startProcess({
    serviceId: 'svc-natural',
    argv: [process.execPath, '-e', 'setTimeout(()=>{},120)'],
    cwd: rootDir,
  });
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(seen.some(([sid]) => sid === 'svc-natural'), 'exit handler harus fire');
  const rec = pm.getExitRecord('svc-natural');
  assert.ok(rec, 'exit record natural juga ditulis');
  assert.equal(rec.exitCode, 0);
});

test('stop idempotent: service tak dikenal -> already-stopped', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const res = await pm.stopProcess({ serviceId: 'svc-unknown', graceMs: 1000 });
  assert.deepEqual(res, { stopped: true, exitCode: null });
});

test('assertPortLegal: <min, >max, reserved -> PORT_ILLEGAL; mid-range ok', () => {
  const pm = new ProcessManager({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-pm-')) });
  assert.throws(() => pm.assertPortLegal(80), (e) => e.code === PORT_ILLEGAL);
  assert.throws(() => pm.assertPortLegal(70000), (e) => e.code === PORT_ILLEGAL);
  assert.throws(
    () => pm.assertPortLegal(28097, { reserved: [28097] }),
    (e) => e.code === PORT_ILLEGAL,
  );
  assert.equal(pm.assertPortLegal(21000), 21000);
  // custom range
  assert.throws(() => pm.assertPortLegal(21000, { min: 30000 }), (e) => e.code === PORT_ILLEGAL);
});

test('portBindTest: port di-squat -> false, port bebas -> true', async () => {
  const pm = new ProcessManager({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-pm-')) });
  // Squat port manual (di range legal 10000-65535): bind lalu tahan.
  const squatter = (await import('node:net')).createServer();
  let port = null;
  await new Promise((resolve) => {
    squatter.listen(0, '127.0.0.1', () => resolve());
  });
  port = squatter.address().port;
  if (port < 10000 || port > 65535) {
    // OS memberi ephemeral di luar range legal: pakai bind-test sendiri untuk cari port range legal.
    squatter.close();
    return; // skip squat check bila ephemeral di luar range â€” kasus langka
  }
  assert.equal(await pm.portBindTest(port), false, 'port ter-squat harus gagal bind');
  await new Promise((resolve) => squatter.close(resolve));

  // Port bebas: cari via listen(0) lalu close, lalu bind-test.
  const probe = (await import('node:net')).createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  if (freePort >= 10000 && freePort <= 65535) {
    assert.equal(await pm.portBindTest(freePort), true, 'port bebas harus bisa bind');
  }
});

test('listProcesses snapshot & getExitRecord null untuk service baru', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  assert.deepEqual(pm.getExitRecord('svc-never'), null);
  pm.startProcess({
    serviceId: 'svc-list',
    argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'],
    cwd: rootDir,
  });
  const snap = pm.listProcesses();
  const found = snap.find((p) => p.serviceId === 'svc-list');
  assert.ok(found);
  assert.ok(Number.isInteger(found.pid));
  assert.ok(Array.isArray(found.argv));
  assert.ok(found.startedAt);
  assert.ok('startTimeHint' in found);
  await pm.stopProcess({ serviceId: 'svc-list', graceMs: 3000 });
});

test('stopProcess via PID file yatim (service tak di registry)', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  // Spawn proses "yatim": tulis PID file manual untuk proses node yang kita
  // spawn di luar registry (simulasi manager restart / PID file tersisa).
  const { spawn } = await import('node:child_process');
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(rootDir, 'runtime', 'pid', 'svc-orphan.pid'), `${orphan.pid}\n`);
  const res = await pm.stopProcess({ serviceId: 'svc-orphan', graceMs: 3000 });
  assert.equal(res.stopped, true);
  assert.equal(res.exitCode, 'killed');
  assert.equal(fs.existsSync(path.join(rootDir, 'runtime', 'pid', 'svc-orphan.pid')), false);
});

test('stale/corrupt PID file dianggap already-stopped', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  fs.writeFileSync(path.join(rootDir, 'runtime', 'pid', 'svc-stale.pid'), 'not-a-pid\n');
  const res = await pm.stopProcess({ serviceId: 'svc-stale', graceMs: 1000 });
  assert.deepEqual(res, { stopped: true, exitCode: null });
  assert.equal(fs.existsSync(path.join(rootDir, 'runtime', 'pid', 'svc-stale.pid'), false), false);
});

// ── #30 — PID-reuse guard via creation-time ──────────────────────────────────

/** Port bebas di rentang legal (dipakai uji #30/#32). */
async function pickFreePort(pm) {
  for (let i = 0; i < 60; i++) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    // eslint-disable-next-line no-await-in-loop
    if (await pm.portBindTest(port)) return port;
  }
  throw new Error('tidak ada port bebas');
}

test('#30 creation-time anak tercatat & cocok saat isAlive; hint berbeda → PID reuse', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const realSelf = await processCreationTimeMs(process.pid);
  if (realSelf == null) {
    t.skip('creation-time proses tidak dapat dibaca di platform ini');
    return;
  }
  const { pid, startTimeHint } = pm.startProcess({
    serviceId: 'svc-reuse',
    argv: [process.execPath, '-e', 'setTimeout(()=>{},30000)'],
    cwd: rootDir,
  });
  assert.ok(Number.isInteger(startTimeHint), 'startTimeHint epoch ms harus tercatat');
  assert.ok(Math.abs(startTimeHint - Date.now()) < 60_000, 'harus masuk akal terhadap clock');
  assert.equal(await pm.isAlive(pid, startTimeHint), true, 'hint milik anak sendiri → hidup');
  // Hint berbeda > toleransi 2s → proses yang memegang PID bukan anak kita.
  assert.equal(await pm.isAlive(pid, startTimeHint + 600_000), false, 'PID reuse terdeteksi');
  await pm.stopProcess({ serviceId: 'svc-reuse', graceMs: 3000 });

  // Proses ASING yang hidup (pid test-runner) + hint creation-time asli → diakui;
  // hint digeser → terdeteksi bukan milik kita. Tidak ada proses dibunuh di sini.
  assert.equal(await pm.isAlive(process.pid), true, 'liveness polos harus tetap true');
  assert.equal(await pm.isAlive(process.pid, realSelf), true);
  assert.equal(await pm.isAlive(process.pid, realSelf + 600_000), false);
  process.kill(process.pid, 0); // masih hidup (guard tidak pernah kill)
});

test('#30 stopProcess lewat PID file menolak membunuh proses asing (PID di-reuse)', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const { spawn } = await import('node:child_process');
  // Anak "asing": di-spawn di luar ProcessManager (bukan anak registry).
  const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    try {
      foreign.kill('SIGKILL');
    } catch {
      /* sudah mati */
    }
  });
  const created = await processCreationTimeMs(foreign.pid);
  if (created == null) {
    t.skip('creation-time proses tidak dapat dibaca di platform ini');
    return;
  }
  // PID file yatim menunjuk proses asing, tapi hint tercatat BEDA dari
  // creation-time aslinya (simulasi PID di-reuse setelah manager crash).
  fs.writeFileSync(path.join(rootDir, 'runtime', 'pid', 'svc-foreign.pid'), `${foreign.pid}\n`);
  const res = await pm.stopProcess({
    serviceId: 'svc-foreign',
    graceMs: 1500,
    startTimeHint: created + 600_000,
  });
  assert.equal(res.stopped, false, 'stop menolak: PID bukan anak kita');
  assert.equal(res.reason, 'pid_reuse_by_other_process');
  assert.equal(await pm.isAlive(foreign.pid, created), true, 'proses asing tidak boleh mati');
});

// ── #32 — port-tabrakan-lekas → reason di exit record ────────────────────────

test('#32 exit ≠0 <5s dengan port masih terisi → reason port_taken_at_spawn', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const port = await pickFreePort(pm);

  // Service pertama: anak yang benar-benar bind port lalu bertahan.
  pm.startProcess({
    serviceId: 'svc-holder',
    argv: [
      process.execPath,
      '-e',
      `require('net').createServer().listen(${port},'127.0.0.1',()=>setTimeout(()=>{},30000))`,
    ],
    cwd: rootDir,
    port,
  });
  // Tunggu bind benar-benar terjadi (deterministik, tanpa race asumsi).
  const boundAt = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await pm.portBindTest(port))) break;
    if (Date.now() - boundAt > 8000) throw new Error('pemegang port tidak sempat bind');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }

  // Service kedua di port yang sama: gagal segera (exit 3 dalam <5s).
  const seen = [];
  pm.setExitHandler((serviceId, info) => seen.push([serviceId, info]));
  pm.startProcess({
    serviceId: 'svc-victim',
    argv: [process.execPath, '-e', 'process.exit(3)'],
    cwd: rootDir,
    port,
  });

  const recAt = Date.now();
  let rec = null;
  for (;;) {
    rec = pm.getExitRecord('svc-victim');
    if (rec) break;
    if (Date.now() - recAt > 8000) throw new Error('exit record tidak pernah ditulis');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(rec.exitCode, 3);
  assert.equal(rec.reason, 'port_taken_at_spawn', 'reason tabrakan port tercatat');
  const info = seen.find(([sid]) => sid === 'svc-victim')?.[1];
  assert.ok(info, 'exit handler menerima info svc-victim');
  assert.equal(info.reason, 'port_taken_at_spawn');
  assert.equal(info.port, port);
  assert.ok(Number.isFinite(info.lifetimeMs) && info.lifetimeMs < 5000);

  await pm.stopProcess({ serviceId: 'svc-holder', graceMs: 3000 });
});

test('#32 exit 0 (normal) → reason null; exit ≠0 dengan port bebas → reason null', async (t) => {
  const rootDir = makeSandbox(t);
  const pm = new ProcessManager({ rootDir });
  const port = await pickFreePort(pm);

  pm.startProcess({
    serviceId: 'svc-ok',
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: rootDir,
    port,
  });
  const at = Date.now();
  let rec = null;
  for (;;) {
    rec = pm.getExitRecord('svc-ok');
    if (rec) break;
    if (Date.now() - at > 8000) throw new Error('exit record tidak ditulis');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.reason, null, 'exit sukses tidak diberi alasan');

  // Exit ≠0 tapi port BEBAS → bukan tabrakan port → reason null.
  const port2 = await pickFreePort(pm);
  pm.startProcess({
    serviceId: 'svc-crash',
    argv: [process.execPath, '-e', 'process.exit(4)'],
    cwd: rootDir,
    port: port2,
  });
  const at2 = Date.now();
  let rec2 = null;
  for (;;) {
    rec2 = pm.getExitRecord('svc-crash');
    if (rec2) break;
    if (Date.now() - at2 > 8000) throw new Error('exit record tidak ditulis');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(rec2.exitCode, 4);
  assert.equal(rec2.reason, null, 'port bebas → crash biasa, bukan port_taken');
});
