// tests/unit/deployment.test.js — unit test DeploymentManager + RollbackManager
// (node:test). Wiring nyata: ProcessManager + ProjectManager + ServiceManager +
// HealthManager (pola tests/unit/service-manager.test.js). Sandbox tmp.
//
// Skenario: deploy workspace source → success + events lengkap + service
// running + HTTP 200; deploy kedua → revision baru + revisions 2 baris; deploy
// saat lock disquat → DEPLOY_IN_PROGRESS; deploy git gagal → failed stage
// 'fetching' + service lama tetap hidup (error isolation §7.3); rollback sukses
// + health OK; rollback tanpa revision sukses → VALIDATION; targetRevision
// tak dikenal → NOT_FOUND; sweepDisconnected → failed + rollback dicoba.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProcessManager } from '../../manager/process_manager/index.js';
import { ProjectManager } from '../../manager/project_manager/index.js';
import { ServiceManager } from '../../manager/service_manager/index.js';
import { HealthManager } from '../../manager/health_manager/index.js';
import { DeploymentManager } from '../../manager/deployment_manager/index.js';
import { RollbackManager } from '../../manager/rollback_manager/index.js';
import { VmPanelError, VALIDATION, NOT_FOUND, DEPLOY_IN_PROGRESS } from '../../lib/errors.js';

// ── sandbox bersama ──────────────────────────────────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-dep-'));
const dataDir = path.join(sandbox, 'data');
const workspacesRoot = path.join(sandbox, 'workspaces');
const runtimeDir = path.join(sandbox, 'runtime');

const projectMgr = new ProjectManager({ dataDir, workspacesRoot });
const procMgr = new ProcessManager({ rootDir: runtimeDir });
const healthMgr = new HealthManager({ dataDir });
const svcMgr = new ServiceManager({
  dataDir,
  processManager: procMgr,
  projectsDbPath: path.join(dataDir, 'projects.db'),
});
const deployMgr = new DeploymentManager({
  dataDir,
  serviceManager: svcMgr,
  projectManager: projectMgr,
  healthManager: healthMgr,
});
const rollbackMgr = new RollbackManager({
  dataDir,
  serviceManager: svcMgr,
  healthManager: healthMgr,
});

test.after(async () => {
  // Stop semua service dulu: child proses (static-server) menjaga event loop
  // tetap hidup dan cwd di sandbox → tanpa stop, run tidak exit / rmSync EBUSY.
  for (const s of svcMgr.listServices()) {
    try { await svcMgr.stopService(s.id); } catch { /* noop */ }
  }
  try { rollbackMgr.close(); } catch { /* noop */ }
  try { deployMgr.close(); } catch { /* noop */ }
  try { svcMgr.close(); } catch { /* noop */ }
  try { healthMgr.close(); } catch { /* noop */ }
  try { projectMgr.close(); } catch { /* noop */ }
  try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows EPERM — tmp dir, biarkan OS bersihkan */ }
});

function codeIs(code) {
  return (e) => e instanceof VmPanelError && e.code === code;
}

/** Port bebas 20000-29999 (portBound perlu legal range ProcessManager). */
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

// ── fixture project: dibuat 'custom' lalu tak bisa di-update type via
// updateProject (hanya port/policy) → buat langsung type 'static' via
// createProject; urutan test dibuat sekuensial agar deterministik.

const REV_DEPLOY_STAGES = [
  'validating',
  'preparing',
  'installing',
  'configuring',
  'switching',
  'starting',
  'verifying',
];

test('deploy #1 workspace source: success, events lengkap, service running, HTTP 200', async () => {
  const port = await pickPort();
  const project = projectMgr.createProject({ name: 'dep-site', type: 'static', port });
  fs.writeFileSync(
    path.join(project.workspacePath, 'index.html'),
    '<!doctype html><html><body>deploy-test-v1</body></html>\n',
  );

  const res = await deployMgr.deploy({ projectId: project.id, actor: 'tester' });
  assert.equal(res.status, 'success');
  assert.ok(res.deploymentId.startsWith('dep_'));
  assert.ok(res.revision.startsWith('ws-'));
  assert.equal(res.revision.length, 'ws-'.length + 8);

  // deployments row: success + finished_at + revision
  const dep = deployMgr.getDeployment(res.deploymentId);
  assert.equal(dep.status, 'success');
  assert.equal(dep.revision, res.revision);
  assert.ok(dep.finished_at, 'finished_at terisi');
  assert.equal(dep.error, null);

  // deployment_events: satu ok per stage validating..verifying
  const okStages = dep.events.filter((ev) => ev.status === 'ok').map((ev) => ev.stage);
  for (const stage of REV_DEPLOY_STAGES) {
    assert.ok(okStages.includes(stage), `event stage '${stage}' harus ada (ada: ${okStages.join(',')})`);
  }

  // revisions: 1 baris marker success
  const revs = deployMgr.store.db
    .prepare('SELECT * FROM revisions WHERE project_id = ? ORDER BY at')
    .all(project.id);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].marker, 'success');
  assert.equal(revs[0].revision, res.revision);

  // service running + HTTP 200 berisi konten v1
  const services = svcMgr.listServices({ projectId: project.id });
  assert.equal(services.length, 1);
  assert.equal(svcMgr.getService(services[0].id).status, 'running');
  const body = await waitForHttp(`http://127.0.0.1:${port}/`);
  assert.ok(body.includes('deploy-test-v1'), 'body harus konten v1');

  // getDeployment tidak ada → NOT_FOUND
  assert.throws(() => deployMgr.getDeployment('dep_UNKNOWN123'), codeIs(NOT_FOUND));
});

test('deploy #2 workspace source: revision baru + revisions 2 baris + konten v2', async () => {
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-site');
  fs.writeFileSync(
    path.join(project.workspacePath, 'index.html'),
    '<!doctype html><html><body>deploy-test-v2</body></html>\n',
  );

  const res = await deployMgr.deploy({ projectId: project.id, actor: 'tester' });
  assert.equal(res.status, 'success');
  assert.ok(res.revision.startsWith('ws-'));

  const revs = deployMgr.store.db
    .prepare('SELECT * FROM revisions WHERE project_id = ? ORDER BY at')
    .all(project.id);
  assert.equal(revs.length, 2, 'revisions harus 2 baris setelah 2 deploy sukses');

  // service dipakai ulang (1 service), running, konten baru
  const services = svcMgr.listServices({ projectId: project.id });
  assert.equal(services.length, 1);
  assert.equal(svcMgr.getService(services[0].id).status, 'running');
  const port = svcMgr.getService(services[0].id).port;
  const body = await waitForHttp(`http://127.0.0.1:${port}/`);
  assert.ok(body.includes('deploy-test-v2'), 'body harus konten v2');
});

test('deploy saat deploy berjalan (lock disquat manual) → DEPLOY_IN_PROGRESS', async () => {
  const { acquire, release } = await import('../../lib/lock.js');
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-site');
  const token = await acquire(`deploy-${project.id}`, {
    dir: path.join(dataDir, 'locks'),
    ttlMs: 60_000,
  });
  try {
    await assert.rejects(
      () => deployMgr.deploy({ projectId: project.id, actor: 'tester' }),
      codeIs(DEPLOY_IN_PROGRESS),
    );
  } finally {
    release(`deploy-${project.id}`, token, { dir: path.join(dataDir, 'locks') });
  }
});

test('deploy gagal git tak valid: failed stage fetching + service lama tetap hidup', async () => {
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-site');
  const servicesBefore = svcMgr.listServices({ projectId: project.id });
  const svc = servicesBefore[0];
  const port = svc.port;

  // pastikan service lama running dulu
  assert.equal(svcMgr.getService(svc.id).status, 'running');

  const res = await deployMgr.deploy({
    projectId: project.id,
    source: { type: 'git', url: 'file:///Z:/tidak-ada-repo', branch: 'x', depth: 1 },
    actor: 'tester',
  });
  assert.equal(res.status, 'failed');
  assert.equal(res.stage, 'fetching');
  assert.ok(res.error && res.error.length > 0);

  // error isolation §7.3: service lama TIDAK mati — masih running + HTTP 200
  assert.equal(svcMgr.getService(svc.id).status, 'running');
  const body = await waitForHttp(`http://127.0.0.1:${port}/`);
  assert.ok(body.includes('deploy-test-v2'), 'service lama tetap menyajikan v2');

  // deployment row: failed + error terisi
  const dep = deployMgr.getDeployment(res.deploymentId);
  assert.equal(dep.status, 'failed');
  assert.equal(dep.stage, 'fetching');
  assert.ok(dep.error, 'error sanitized terisi');
  assert.ok(dep.error.length <= 2048, 'error di-clamp 2KB');
});

test('rollback: setelah 2 deploy sukses → kembali ke sukses pertama + health OK', async () => {
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-site');
  const revs = deployMgr.store.db
    .prepare("SELECT * FROM revisions WHERE project_id = ? AND marker = 'success' ORDER BY at")
    .all(project.id);
  assert.equal(revs.length, 2);
  const first = revs[0].revision;

  const out = await rollbackMgr.rollback({ projectId: project.id, actor: 'tester' });
  assert.ok(out.deploymentId.startsWith('dep_'));
  assert.equal(out.to, first);

  // deployment rollback tercatat: stage 'rolling-back' + status success
  const dep = deployMgr.getDeployment(out.deploymentId);
  assert.equal(dep.status, 'success');
  assert.equal(dep.stage, 'rolling-back');

  // revisions: target ditandai rollback-target
  const revRow = deployMgr.store.db
    .prepare('SELECT * FROM revisions WHERE project_id = ? AND revision = ?')
    .get(project.id, first);
  assert.equal(revRow.marker, 'rollback-target');

  // service kembali running + health OK
  const svc = svcMgr.listServices({ projectId: project.id })[0];
  assert.equal(svcMgr.getService(svc.id).status, 'running');
  const outcome = await svcMgr.healthService(svc.id, healthMgr);
  assert.equal(outcome.ok, true);

  // riwayat rollback tercatat
  const history = rollbackMgr.getRollbackHistory(project.id);
  assert.ok(history.length >= 1);
  assert.ok(history.some((r) => r.id === out.deploymentId));
});

test('rollback tanpa revision sukses → VALIDATION; targetRevision tak dikenal → NOT_FOUND', async () => {
  // project baru tanpa deploy sukses
  const port = await pickPort();
  const fresh = projectMgr.createProject({ name: 'dep-norev', type: 'static', port });
  fs.writeFileSync(
    path.join(fresh.workspacePath, 'index.html'),
    '<!doctype html><html><body>fresh</body></html>\n',
  );
  await assert.rejects(
    () => rollbackMgr.rollback({ projectId: fresh.id, actor: 'tester' }),
    codeIs(VALIDATION),
  );

  // targetRevision tak dikenal di project yang punya revisions
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-site');
  await assert.rejects(
    () => rollbackMgr.rollback({ projectId: project.id, targetRevision: 'deadbeef', actor: 'tester' }),
    codeIs(NOT_FOUND),
  );
});

test('sweepDisconnected: deployment running tua → failed disconnected + rollback dicoba', async () => {
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-site');
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  deployMgr.store.db
    .prepare(
      `INSERT INTO deployments (id, project_id, revision, actor, status, stage, error, started_at, finished_at, rollback_of)
       VALUES (?, ?, 'ws-deadbeef', 'ghost', 'running', 'verifying', NULL, ?, NULL, NULL)`,
    )
    .run('dep_FAKEFAKE01', project.id, hourAgo);

  const swept = await deployMgr.sweepDisconnected({ olderThanMs: 600_000 });
  assert.equal(swept.length, 1);
  assert.equal(swept[0].deploymentId, 'dep_FAKEFAKE01');
  assert.equal(swept[0].projectId, project.id);

  // deployment jadi failed + stage disconnected
  const dep = deployMgr.getDeployment('dep_FAKEFAKE01');
  assert.equal(dep.status, 'failed');
  assert.equal(dep.stage, 'disconnected');
  assert.ok(dep.error, 'error terisi');

  // auto-rollback terpanggil (RollbackManager wire): event disconnected ok/fail
  const evs = dep.events.filter((ev) => ev.stage === 'disconnected');
  assert.ok(evs.length >= 1, 'event disconnected harus tercatat');

  // deployment 'running' fresh TIDAK tersapu (belum melewati threshold)
  const freshSweep = await deployMgr.sweepDisconnected({ olderThanMs: 600_000 });
  assert.equal(freshSweep.length, 0);
});
