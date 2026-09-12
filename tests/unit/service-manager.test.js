// tests/unit/service-manager.test.js — unit test ServiceManager (node:test).
// Skenario: createService (port legal, project tak ada → NOT_FOUND), start/stop
// static service nyata (ProcessManager nyata, fetch HTTP 200), duplikat port
// antar 2 service → PORT_IN_USE saat start kedua, start saat running →
// VALIDATION, restart, disable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProcessManager } from '../../manager/process_manager/index.js';
import { ProjectManager } from '../../manager/project_manager/index.js';
import { ServiceManager } from '../../manager/service_manager/index.js';
import { genId } from '../../lib/ids.js';
import { VmPanelError, VALIDATION, NOT_FOUND, PORT_IN_USE } from '../../lib/errors.js';

// ── sandbox bersama (dibuat sekali, dirapikan via after) ─────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-svcm-'));
const dataDir = path.join(sandbox, 'data');
const workspacesRoot = path.join(sandbox, 'workspaces');
const runtimeDir = path.join(sandbox, 'runtime');

const projectMgr = new ProjectManager({ dataDir, workspacesRoot });
const procMgr = new ProcessManager({ rootDir: runtimeDir });
const svcMgr = new ServiceManager({
  dataDir,
  processManager: procMgr,
  projectsDbPath: path.join(dataDir, 'projects.db'),
});

test.after(() => {
  try { svcMgr.close(); } catch { /* noop */ }
  try { projectMgr.close(); } catch { /* noop */ }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// project fixture + workspace index.html (untuk adapter static)
const project = projectMgr.createProject({ name: 'svc-site', type: 'static' });
fs.writeFileSync(
  path.join(project.workspacePath, 'index.html'),
  '<!doctype html><html><body>vm-panel-service-test</body></html>\n',
);

/** Port bebas di rentang 20000-29999 (dicek via portBindTest ProcessManager). */
async function pickPort() {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    // eslint-disable-next-line no-await-in-loop
    if (await procMgr.portBindTest(port)) return port;
  }
  throw new Error('tidak ada port bebas ditemukan');
}

/** Poll fetch sampai 200 atau timeout. */
async function waitForHttp(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      const body = await res.text().catch(() => '');
      if (res.status === 200) return body;
    } catch {
      /* belum listen — retry */
    }
    if (Date.now() > deadline) throw new Error(`timeout menunggu ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function codeIs(code) {
  return (e) => e instanceof VmPanelError && e.code === code;
}

// ── createService ────────────────────────────────────────────────────────────

test('createService: record lengkap + ports row; getService/format guard', async () => {
  const port = await pickPort();
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'alpha',
    type: 'static',
    port,
  });
  assert.ok(svc.id.startsWith('svc_'));
  assert.equal(svc.projectId, project.id);
  assert.equal(svc.name, 'alpha');
  assert.equal(svc.type, 'static');
  assert.equal(svc.status, 'stopped');
  assert.equal(svc.enabled, true);
  assert.equal(svc.port, port);
  // ports row tercatat
  const portRow = svcMgr.store.db.prepare('SELECT * FROM ports WHERE port = ?').get(port);
  assert.ok(portRow, 'ports row harus ada');
  assert.equal(portRow.service_id, svc.id);
  // config JSON berisi rootDir = workspacePath project
  assert.equal(svc.config.rootDir, project.workspacePath);

  // id format invalid → VALIDATION
  assert.throws(() => svcMgr.getService('bukan-id'), codeIs(VALIDATION));
  // id valid-format tapi tidak ada → NOT_FOUND
  assert.throws(() => svcMgr.getService(genId('svc_')), codeIs(NOT_FOUND));
});

test('createService: project tak ada → NOT_FOUND; type tak dikenal → VALIDATION', async () => {
  const port = await pickPort();
  assert.throws(
    () => svcMgr.createService({ projectId: genId('prj_'), name: 'ghost', type: 'static', port }),
    codeIs(NOT_FOUND),
  );
  assert.throws(
    () => svcMgr.createService({ projectId: project.id, name: 'bad-type', type: 'cobol', port }),
    codeIs(VALIDATION),
  );
});

// ── start/stop static service nyata ──────────────────────────────────────────

test('startService static nyata: pid > 0, status running, HTTP 200; stop → stopped + ports row hilang; disable', async () => {
  const port = await pickPort();
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'main-site',
    type: 'static',
    port,
  });

  const started = await svcMgr.startService(svc.id);
  assert.ok(Number.isInteger(started.pid) && started.pid > 0, 'pid > 0');
  assert.equal(started.serviceId, svc.id);
  assert.equal(started.port, port);

  const rec = svcMgr.getService(svc.id);
  assert.equal(rec.status, 'running');
  assert.equal(rec.pid, started.pid);
  assert.ok(rec.startedAt, 'started_at terisi');

  // HTTP fetch → 200
  const body = await waitForHttp(`http://127.0.0.1:${port}/`);
  assert.ok(body.includes('vm-panel-service-test'), 'body harus dari fixture index.html');

  // supervisor_state 'running'
  const sup = svcMgr.getSupervisorState(svc.id);
  assert.equal(sup.state, 'running');
  assert.equal(sup.restartCount, 0);

  // stop → status stopped, pid null, ports row hilang
  await svcMgr.stopService(svc.id);
  const after = svcMgr.getService(svc.id);
  assert.equal(after.status, 'stopped');
  assert.equal(after.pid, null);
  const portRow = svcMgr.store.db.prepare('SELECT * FROM ports WHERE service_id = ?').get(svc.id);
  assert.equal(portRow, undefined, 'ports row harus hilang setelah stop');
  const supAfter = svcMgr.getSupervisorState(svc.id);
  assert.equal(supAfter.state, 'stopped_by_user');

  // disable → status 'disabled', enabled 0
  const disabled = await svcMgr.disable(svc.id);
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.enabled, false);
  // enable kembali
  const enabled = svcMgr.enable(svc.id);
  assert.equal(enabled.status, 'stopped');
  assert.equal(enabled.enabled, true);
});

test('start saat running → VALIDATION; restartService → running lagi', async () => {
  const port = await pickPort();
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'restart-site',
    type: 'static',
    port,
  });
  const first = await svcMgr.startService(svc.id);
  assert.ok(first.pid > 0);
  await waitForHttp(`http://127.0.0.1:${port}/`);

  // start lagi saat running → VALIDATION 'bad state'
  await assert.rejects(() => svcMgr.startService(svc.id), codeIs(VALIDATION));

  // restart → running lagi
  const restarted = await svcMgr.restartService(svc.id);
  assert.ok(restarted.pid > 0);
  const rec = svcMgr.getService(svc.id);
  assert.equal(rec.status, 'running');
  await waitForHttp(`http://127.0.0.1:${port}/`);

  await svcMgr.stopService(svc.id);
});

test('duplikat port antar 2 service → PORT_IN_USE saat start kedua', async () => {
  const port = await pickPort();
  const a = svcMgr.createService({ projectId: project.id, name: 'dup-a', type: 'static', port });
  const b = svcMgr.createService({ projectId: project.id, name: 'dup-b', type: 'static', port });
  assert.notEqual(a.id, b.id);

  // service pertama start sukses
  const sa = await svcMgr.startService(a.id);
  assert.ok(sa.pid > 0);
  await waitForHttp(`http://127.0.0.1:${port}/`);

  // start kedua dengan port sama → PORT_IN_USE (bind test gagal)
  await assert.rejects(() => svcMgr.startService(b.id), codeIs(PORT_IN_USE));
  // status kedua tetap stopped
  assert.equal(svcMgr.getService(b.id).status, 'stopped');

  await svcMgr.stopService(a.id);
});

test('updateConfig: memperbarui port dan menyinkronkan ports table secara atomik', async () => {
  const port1 = await pickPort();
  const port2 = await pickPort();
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'update-port-site',
    type: 'static',
    port: port1,
  });

  assert.equal(svc.port, port1);
  const initialPortRow = svcMgr.store.db.prepare('SELECT * FROM ports WHERE service_id = ?').get(svc.id);
  assert.equal(initialPortRow.port, port1);

  // Update port via updateConfig
  const updated = svcMgr.updateConfig(svc.id, { port: port2 });
  assert.equal(updated.port, port2);

  // Verifikasi tabel services & ports di database
  const svcRow = svcMgr.store.db.prepare('SELECT port FROM services WHERE id = ?').get(svc.id);
  assert.equal(svcRow.port, port2);

  const newPortRow = svcMgr.store.db.prepare('SELECT * FROM ports WHERE service_id = ?').get(svc.id);
  assert.equal(newPortRow.port, port2);

  const oldPortRow = svcMgr.store.db.prepare('SELECT * FROM ports WHERE port = ?').get(port1);
  assert.equal(oldPortRow, undefined);
});

test('setSupervisorState: partial update tidak menghapus crash_loop, backoff_until, dan consecutive_failures', () => {
  const svcId = genId('svc_');
  // Initial state dengan crashLoop = true dan backoff
  svcMgr.setSupervisorState(svcId, {
    state: 'failed',
    restartCount: 3,
    crashLoop: true,
    backoffUntil: 1726000000000,
    consecutiveFailures: 2,
    lastEvent: 'crash',
  });

  const st1 = svcMgr.getSupervisorState(svcId);
  assert.equal(st1.state, 'failed');
  assert.equal(st1.crashLoop, true);
  assert.equal(st1.restartCount, 3);
  assert.equal(st1.consecutiveFailures, 2);
  assert.equal(st1.backoffUntil, '1726000000000');

  // Lakukan partial update: hanya ubah state tanpa crashLoop
  svcMgr.setSupervisorState(svcId, {
    state: 'recovering',
  });

  const st2 = svcMgr.getSupervisorState(svcId);
  assert.equal(st2.state, 'recovering');
  assert.equal(st2.crashLoop, true, 'crashLoop tidak boleh di-reset ke 0');
  assert.equal(st2.restartCount, 3, 'restartCount harus dipertahankan');
  assert.equal(st2.consecutiveFailures, 2, 'consecutiveFailures harus dipertahankan');
  assert.equal(st2.backoffUntil, '1726000000000', 'backoffUntil harus dipertahankan');
});

// ── #31b — rekonsiliasi baris 'running' yatim saat manager start ──────────────

/** Kumpulkan event audit lewat fake auditManager (restore setelah test). */
async function withFakeAudit(fn) {
  const events = [];
  const prev = svcMgr.auditManager;
  svcMgr.auditManager = { append: (e) => events.push(e) };
  try {
    await fn();
  } finally {
    svcMgr.auditManager = prev;
  }
  return events;
}

const waitAliveFalse = async (pid, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await procMgr.isAlive(pid))) return true;
    if (Date.now() > deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
};

test('#31b reconcileStaleRunning: baris running dengan PID mati → failed + audit service.reconciled_dead', async () => {
  const { spawn } = await import('node:child_process');
  const port = await pickPort();
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'reconcile-dead',
    type: 'static',
    port,
  });

  // PID squatting NYATA: spawn anak node sungguhan → bunuh → PID-nya pasti mati.
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const deadPid = child.pid;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  assert.ok(await waitAliveFalse(deadPid), 'proses squatting harus benar-benar mati');

  // Simulasi crash manager: baris tertinggal status 'running' dengan pid mati.
  svcMgr.store.db
    .prepare(`UPDATE services SET status = 'running', pid = ?, started_at = ? WHERE id = ?`)
    .run(deadPid, new Date().toISOString(), svc.id);

  const events = await withFakeAudit(async () => {
    const res = await svcMgr.reconcileStaleRunning();
    assert.ok(
      res.reconciled.some((r) => r.serviceId === svc.id),
      'service harus masuk daftar rekonsiliasi',
    );
  });

  const after = svcMgr.getService(svc.id);
  assert.equal(after.status, 'failed', 'baris running yatim → failed');
  assert.equal(after.pid, null, 'pid dibersihkan');
  assert.equal(after.startTimeHint, null, '#30 hint tidak dipakai oleh baris tanpa hint');
  const sup = svcMgr.getSupervisorState(svc.id);
  assert.equal(sup.state, 'failed');
  assert.equal(sup.lastEvent, 'reconciled_dead');

  const audited = events.filter((e) => e.operation === 'service.reconciled_dead');
  assert.equal(audited.length, 1, 'audit event service.reconciled_dead tercatat 1x');
  assert.equal(audited[0].serviceId, svc.id);
  assert.equal(audited[0].actor, 'system');
  assert.equal(audited[0].statusAfter, 'failed');

  // Ports row TIDAK boleh dihapus (masih reservasi sah untuk start berikutnya).
  const portRow = svcMgr.store.db.prepare('SELECT * FROM ports WHERE service_id = ?').get(svc.id);
  assert.ok(portRow, 'ports row harus tetap ada setelah rekonsiliasi');

  // Service tetap bisa di-start lagi setelah rekonsiliasi (status failed legal).
  await svcMgr.startService(svc.id);
  await svcMgr.stopService(svc.id);
});

test('#31b guard: PID hidup tapi tak dikenal registry → dibiarkan running, tidak di-kill', async () => {
  const port = await pickPort();
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'reconcile-orphan',
    type: 'static',
    port,
  });
  // PID proses test-runner itu sendiri: hidup, pasti bukan anak ProcessManager.
  svcMgr.store.db
    .prepare(`UPDATE services SET status = 'running', pid = ? WHERE id = ?`)
    .run(process.pid, svc.id);

  const res = await svcMgr.reconcileStaleRunning();
  assert.equal(
    res.reconciled.some((r) => r.serviceId === svc.id),
    false,
    'PID hidup tidak boleh direkonsiliasi jadi failed',
  );
  assert.ok(res.orphans.some((o) => o.serviceId === svc.id && o.pid === process.pid));

  const after = svcMgr.getService(svc.id);
  assert.equal(after.status, 'running', 'baris dibiarkan (proses yatim 24/7)');

  // Proses asing tidak boleh mati.
  let killGuardOk = true;
  try {
    process.kill(process.pid, 0);
  } catch {
    killGuardOk = false;
  }
  assert.ok(killGuardOk, 'rekonsiliasi dilarang membunuh proses apa pun');

  // Bereskan baris palsu agar tidak mengganggu test lain.
  svcMgr.store.db
    .prepare(`UPDATE services SET status = 'stopped', pid = NULL WHERE id = ?`)
    .run(svc.id);
});

// ── #30 — creation-time guard di level service ────────────────────────────────

test('#30 startService mencatat start_time_hint; stopService membersihkannya', async () => {
  const port = await pickPort();
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'hint-site',
    type: 'static',
    port,
  });
  const started = await svcMgr.startService(svc.id);
  const rec = svcMgr.getService(svc.id);
  if (process.platform === 'win32') {
    assert.ok(Number.isInteger(rec.startTimeHint), 'Windows: hint epoch ms tercatat saat spawn');
  }
  if (rec.startTimeHint != null) {
    assert.equal(
      await procMgr.isAlive(started.pid, rec.startTimeHint),
      true,
      'hint tersimpan harus diakui sebagai anak sendiri',
    );
    assert.equal(
      await procMgr.isAlive(started.pid, rec.startTimeHint + 600_000),
      false,
      'hint berbeda → PID reuse terdeteksi',
    );
  }
  await svcMgr.stopService(svc.id);
  assert.equal(svcMgr.getService(svc.id).startTimeHint, null, 'hint dibersihkan saat stop');
});

test('#30 #31b reconcile dengan hint: PID hidup tapi creation-time beda → failed, proses asing selamat', async (t) => {
  const { spawn } = await import('node:child_process');
  const { processCreationTimeMs } = await import('../../manager/process_manager/index.js');
  const port = await pickPort();
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'hint-reuse',
    type: 'static',
    port,
  });
  // Proses hidup yang BUKAN anak ProcessManager.
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
    t.skip('creation-time tidak terbaca di platform ini');
    return;
  }
  // Baris 'running' dengan hint yang TIDAK cocok → PID sudah di-reuse.
  svcMgr.store.db
    .prepare(`UPDATE services SET status = 'running', pid = ?, start_time_hint = ? WHERE id = ?`)
    .run(foreign.pid, created + 600_000, svc.id);

  const res = await svcMgr.reconcileStaleRunning();
  assert.ok(
    res.reconciled.some((r) => r.serviceId === svc.id),
    'PID reuse harus direkonsiliasi jadi failed',
  );
  assert.equal(svcMgr.getService(svc.id).status, 'failed');
  assert.equal(
    await procMgr.isAlive(foreign.pid, created),
    true,
    'proses asing TIDAK boleh dimatikan rekonsiliasi',
  );
});

// ── #32 — reason tabrakan port di exit record + alert ────────────────────────

test('#32 exit ≠0 <5s dengan port terisi → reason port_taken_at_spawn (record + audit + supervisor)', async () => {
  const port = await pickPort();
  const holder = svcMgr.createService({
    projectId: project.id,
    name: 'port-holder',
    type: 'static',
    port,
  });
  await svcMgr.startService(holder.id);
  await waitForHttp(`http://127.0.0.1:${port}/`);

  // Service kedua di port yang sama: barisnya 'running' (pola start yang gagal
  // segera), prosesnya di-spawn langsung agar melewati pre-check PORT_IN_USE.
  const victim = svcMgr.createService({
    projectId: project.id,
    name: 'port-victim',
    type: 'static',
    port,
  });
  const events = await withFakeAudit(async () => {
    svcMgr.store.db
      .prepare(`UPDATE services SET status = 'running', pid = ? WHERE id = ?`)
      .run(424242, victim.id);
    procMgr.startProcess({
      serviceId: victim.id,
      argv: [process.execPath, '-e', 'process.exit(5)'],
      cwd: sandbox,
      port,
    });
    const at = Date.now();
    for (;;) {
      if (svcMgr.getService(victim.id).status === 'failed') break;
      if (Date.now() - at > 10000) throw new Error('exit handler tidak menandai failed');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  const exitRec = procMgr.getExitRecord(victim.id);
  assert.ok(exitRec, 'exit record harus ada');
  assert.equal(exitRec.exitCode, 5);
  assert.equal(exitRec.reason, 'port_taken_at_spawn', 'reason tabrakan port tercatat');

  const crashed = events.filter((e) => e.operation === 'processCrashed');
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0].input.reason, 'port_taken_at_spawn');
  assert.match(crashed[0].input.message, /tabrakan port/, 'pesan alert dibedakan dari crash biasa');
  assert.equal(
    svcMgr.getSupervisorState(victim.id).lastEvent,
    'port_taken_at_spawn',
    'event supervisor dibedakan dari crash biasa',
  );

  await svcMgr.stopService(holder.id);
});
