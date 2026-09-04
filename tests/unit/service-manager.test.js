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
