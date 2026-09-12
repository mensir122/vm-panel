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
import { DeploymentManager, hashWorkspace } from '../../manager/deployment_manager/index.js';
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

test('#36 sweepDisconnected: started_at rusak tidak membuat sweep throw (skip + log)', async () => {
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-site');
  const logs = [];
  const prevLogger = deployMgr.logger;
  deployMgr.logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, extra) => logs.push({ msg, extra }),
    error: (msg, extra) => logs.push({ msg, extra }),
  };
  try {
    deployMgr.store.db
      .prepare(
        `INSERT INTO deployments (id, project_id, revision, actor, status, stage, error, started_at, finished_at, rollback_of)
         VALUES (?, ?, NULL, 'ghost', 'running', 'installing', NULL, ?, NULL, NULL)`,
      )
      .run('dep_BROENTIME1', project.id, 'bukan-tanggal-sama-sekali');

    let swept;
    await assert.doesNotReject(
      async () => {
        swept = await deployMgr.sweepDisconnected({ olderThanMs: 600_000 });
      },
      'started_at rusak tidak boleh membuat sweep melempar',
    );
    assert.equal(
      swept.some((r) => r.deploymentId === 'dep_BROENTIME1'),
      false,
      'baris bertimestamp rusak harus DI-LEWATI (tidak di-rollback)',
    );
    assert.equal(deployMgr.getDeployment('dep_BROENTIME1').status, 'running');
    assert.ok(
      logs.some((l) => l.msg === 'deployment.sweep.skipped_unparsable_started_at'),
      'skip harus dicatat di log',
    );
  } finally {
    deployMgr.logger = prevLogger;
    // Bereskan baris rusak agar test sweep berikutnya tidak terpengaruh.
    deployMgr.store.db
      .prepare(
        `UPDATE deployments SET status = 'failed', finished_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), 'dep_BROENTIME1');
  }
});

test('#36 parseTimeMs: ISO Z, offset non-UTC, epoch numerik, dan nilai rusak', async () => {
  const { parseTimeMs } = await import('../../manager/deployment_manager/index.js');
  assert.equal(parseTimeMs('2026-09-13T10:00:00.000Z'), Date.parse('2026-09-13T10:00:00.000Z'));
  assert.equal(parseTimeMs('2026-09-13T17:00:00+07:00'), Date.parse('2026-09-13T17:00:00+07:00'));
  assert.equal(parseTimeMs('1700000000000'), 1700000000000);
  assert.equal(parseTimeMs(1700000000000), 1700000000000);
  assert.equal(parseTimeMs('bukan-tanggal'), null);
  assert.equal(parseTimeMs(''), null);
  assert.equal(parseTimeMs(null), null);
  assert.equal(parseTimeMs(undefined), null);

  // Regresi inti #36: cutoff dibandingkan sebagai epoch, BUKAN string.
  // '…T12:00:00+07:00' (= 05:00:00Z) lebih tua dari cutoff 06:00:00Z walau
  // secara lexicografis string-nya "lebih besar".
  const nowMs = Date.parse('2026-09-13T06:30:00.000Z');
  const cutoffMs = nowMs - 1800_000; // 06:00:00Z
  assert.ok(parseTimeMs('2026-09-13T12:00:00+07:00') < cutoffMs, 'harus terbaca lebih tua');
  assert.ok('2026-09-13T12:00:00+07:00' > '2026-09-13T06:00:00.000Z', 'string compare justru salah');
});

test('python subfolder entrypoint: _deriveServiceConfigExtra mengenali subfolder dan startCmd', () => {
  const ws = path.join(workspacesRoot, 'py-sub-ws');
  fs.mkdirSync(path.join(ws, 'hermes-agent'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'hermes-agent', 'run_agent.py'), 'print("agent")\n');

  // Case 1: auto-detect di subfolder
  const extra1 = deployMgr._deriveServiceConfigExtra({ type: 'python', port: 10001 }, ws);
  assert.equal(extra1.main, 'hermes-agent/run_agent.py');

  // Case 2: eksplisit startCmd
  const extra2 = deployMgr._deriveServiceConfigExtra({
    type: 'python',
    port: 10001,
    startCmd: 'python hermes-agent/run_agent.py',
  }, ws);
  assert.equal(extra2.main, 'hermes-agent/run_agent.py');
});

// ── F5 regression: hashWorkspace ─────────────────────────────────────────────

test('F5 hashWorkspace: node_modules/.venv/.git di-skip (tidak mengubah revision)', () => {
  const ws = path.join(workspacesRoot, 'hash-ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'index.js'), 'console.log(1)\n');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'a.js'), 'export const a=1\n');
  const base = hashWorkspace(ws);

  // dependency/venv/git metadata ditambah → hash TIDAK berubah
  fs.mkdirSync(path.join(ws, 'node_modules', 'dep', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'node_modules', 'dep', 'index.js'), 'module.exports={}\n');
  fs.writeFileSync(path.join(ws, 'node_modules', 'dep', 'lib', 'x.js'), 'x\n');
  fs.mkdirSync(path.join(ws, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.venv', 'bin', 'python'), 'binary-ish\n');
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(hashWorkspace(ws), base, 'isi dependency tidak menentukan revision');

  // file sumber berubah → hash berubah
  fs.writeFileSync(path.join(ws, 'src', 'a.js'), 'export const a=2\n');
  assert.notEqual(hashWorkspace(ws), base, 'perubahan source tetap terdeteksi');
});

test('F5 hashWorkspace: file > cap hanya di-hash metadata (nama+ukuran), konten tidak dibaca', () => {
  const ws = path.join(workspacesRoot, 'hash-big-ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'index.js'), 'console.log(1)\n');
  const big = Buffer.alloc(33 * 1024 * 1024, 0x41); // 33MB > cap 32MB
  fs.writeFileSync(path.join(ws, 'big.bin'), big);
  const h1 = hashWorkspace(ws);

  // ukuran sama, konten beda → hash SAMA (metadata-only untuk file di atas cap)
  big.fill(0x42);
  fs.writeFileSync(path.join(ws, 'big.bin'), big);
  assert.equal(hashWorkspace(ws), h1, 'konten file besar tidak ikut di-hash');

  // ukuran beda → hash beda
  fs.writeFileSync(path.join(ws, 'big.bin'), Buffer.alloc(33 * 1024 * 1024 + 1, 0x41));
  assert.notEqual(hashWorkspace(ws), h1, 'ukuran file besar tetap jadi penentu');
});

// ── F5 regression: GC git-sources ────────────────────────────────────────────

test('F5 _gcGitSources: keep-2 terbaru per project, project lain tidak tersentuh', () => {
  const project = projectMgr.createProject({
    name: 'dep-gc',
    type: 'static',
    port: 20999,
  });
  const srcRoot = path.join(dataDir, 'git-sources');
  const now = Date.now() / 1000;
  const dirs = [];
  for (let i = 1; i <= 5; i++) {
    const d = path.join(srcRoot, `git-${project.id}-batch${i}-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'f.txt'), `v${i}`);
    fs.utimesSync(d, now - (5 - i), now - (5 - i)); // batch1 = tertua, batch5 = terbaru
    dirs.push(d);
  }
  // project lain tidak boleh tersentuh
  const other = path.join(srcRoot, 'git-prj_OTHER00001-batch1-1');
  fs.mkdirSync(other, { recursive: true });

  const removed = deployMgr._gcGitSources(project.id);
  assert.equal(removed.length, 3, `3 clone tertua dihapus (got ${removed.length})`);
  assert.equal(fs.existsSync(dirs[0]), false);
  assert.equal(fs.existsSync(dirs[1]), false);
  assert.equal(fs.existsSync(dirs[2]), false);
  assert.ok(fs.existsSync(dirs[3]), 'keep #2 terbaru');
  assert.ok(fs.existsSync(dirs[4]), 'keep #1 terbaru');
  assert.ok(fs.existsSync(other), 'project lain tidak tersapu');
});

test('F5 _gcGitSources: rootDir service aktif selalu dilindungi walau tertua', () => {
  const project = projectMgr.createProject({ name: 'dep-gc2', type: 'static', port: 20998 });
  const srcRoot = path.join(dataDir, 'git-sources');
  const now = Date.now() / 1000;
  const dirs = [];
  for (let i = 1; i <= 4; i++) {
    const d = path.join(srcRoot, `git-${project.id}-keep-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.utimesSync(d, now - (4 - i), now - (4 - i)); // keep-1 tertua … keep-4 terbaru
    dirs.push(d);
  }
  const svc = svcMgr.createService({
    projectId: project.id,
    name: 'svc-dep-gc2',
    type: 'static',
    port: 20998,
    config: { rootDir: dirs[0] }, // rootDir aktif = yang tertua
  });
  assert.equal(svcMgr.getService(svc.id).config.rootDir, dirs[0]);

  const removed = deployMgr._gcGitSources(project.id);
  assert.equal(removed.length, 1, 'hanya keep-2 yang dihapus (keep-1 dilindungi)');
  assert.equal(path.resolve(removed[0]), path.resolve(dirs[1]));
  assert.ok(fs.existsSync(dirs[0]), 'rootDir service aktif tidak pernah dihapus');
  assert.ok(fs.existsSync(dirs[2]) && fs.existsSync(dirs[3]), '2 terbaru keep');
});

// ── F5 regression: lock deploy untuk rollback + sweep (re-entrancy) ──────────

test('F5 rollback(): memegang lock deploy-<projectId> → DEPLOY_IN_PROGRESS bila deploy hidup', async () => {
  const { acquire, release } = await import('../../lib/lock.js');
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-site');
  const token = await acquire(`deploy-${project.id}`, {
    dir: path.join(dataDir, 'locks'),
    ttlMs: 60_000,
  });
  try {
    await assert.rejects(
      () => rollbackMgr.rollback({ projectId: project.id, actor: 'tester' }),
      codeIs(DEPLOY_IN_PROGRESS),
    );
    // kontrak re-entrancy: pemanggil yang sudah memegang lock kirim lock:false
    const out = await rollbackMgr.rollback({
      projectId: project.id,
      actor: 'tester',
      lock: false,
    });
    assert.ok(out.deploymentId.startsWith('dep_'));
  } finally {
    release(`deploy-${project.id}`, token, { dir: path.join(dataDir, 'locks') });
  }
});

test('F5 sweepDisconnected: baris dengan lock dipegang deploy hidup DI-LEWATI (tidak ditandai gagal)', async () => {
  const { acquire, release } = await import('../../lib/lock.js');
  const project = projectMgr.listProjects().find((p) => p.name === 'dep-gc');
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  deployMgr.store.db
    .prepare(
      `INSERT INTO deployments (id, project_id, revision, actor, status, stage, error, started_at, finished_at, rollback_of)
       VALUES (?, ?, 'ws-busy', 'ghost', 'running', 'installing', NULL, ?, NULL, NULL)`,
    )
    .run('dep_BUSY000001', project.id, hourAgo);

  const token = await acquire(`deploy-${project.id}`, {
    dir: path.join(dataDir, 'locks'),
    ttlMs: 60_000,
  });
  try {
    const swept = await deployMgr.sweepDisconnected({ olderThanMs: 600_000 });
    const hit = swept.find((r) => r.deploymentId === 'dep_BUSY000001');
    assert.ok(hit, 'baris dilaporkan');
    assert.equal(hit.skipped, true, 'baris diskip karena lock-held');
    const dep = deployMgr.getDeployment('dep_BUSY000001');
    assert.equal(dep.status, 'running', 'deployment hidup TIDAK boleh ditandai failed');
  } finally {
    release(`deploy-${project.id}`, token, { dir: path.join(dataDir, 'locks') });
  }
  // setelah lock lepas → sweep normal memproses baris yang sama
  const swept2 = await deployMgr.sweepDisconnected({ olderThanMs: 600_000 });
  const hit2 = swept2.find((r) => r.deploymentId === 'dep_BUSY000001');
  assert.ok(hit2 && !hit2.skipped, 'sweep kedua memproses baris yatim');
  assert.equal(deployMgr.getDeployment('dep_BUSY000001').status, 'failed');
  // cleanup agar test berikutnya tidak terseret
  deployMgr.store.db.prepare('DELETE FROM deployments WHERE id = ?').run('dep_BUSY000001');
});

// ── F5 regression: liveness fallback hanya utk check tipe process ────────────

test('F5 verifying: check tcp yang gagal TIDAK ditolong fallback liveness', async () => {
  const fake = {
    _sleep: async () => {},
    healthManager: null,
    _healthCheckType: () => 'tcp',
    serviceManager: {
      healthService: async () => ({ ok: false, error: 'ECONNREFUSED' }),
      getService: () => ({ id: 'svc_fake', status: 'running', pid: process.pid }),
    },
  };
  await assert.rejects(
    () => DeploymentManager.prototype._stageVerifying.call(fake, { id: 'svc_fake' }),
    /ECONNREFUSED/,
    'service tcp mati harus FAILED, bukan lolos karena proses hidup',
  );
});

test('F5 verifying: check tipe process + proses hidup → lolos (fallback sah)', async () => {
  const fake = {
    _sleep: async () => {},
    healthManager: null,
    _healthCheckType: () => 'process',
    serviceManager: {
      healthService: async () => ({ ok: false, error: 'no listener' }),
      getService: () => ({ id: 'svc_fake', status: 'running', pid: process.pid }),
    },
  };
  const note = await DeploymentManager.prototype._stageVerifying.call(fake, { id: 'svc_fake' });
  assert.match(note, /process-type check/);
});

test('F5 _healthCheckType: default adapter static → http; config {type:process} → process', () => {
  const ws = path.join(workspacesRoot, 'hc-ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'index.html'), '<p>x</p>');
  assert.equal(
    deployMgr._healthCheckType({ id: 'svc_hc', type: 'static', rootDir: ws, port: 20998, config: { type: 'static', rootDir: ws, port: 20998 } }),
    'http',
    'static adapter = http check → TIDAK boleh lolos via fallback liveness',
  );
  assert.equal(
    deployMgr._healthCheckType({
      id: 'svc_hc2',
      type: 'custom',
      rootDir: ws,
      port: 20998,
      config: { type: 'custom', rootDir: ws, port: 20998, healthCheck: { type: 'process' } },
    }),
    'process',
  );
  assert.equal(
    deployMgr._healthCheckType({
      id: 'svc_hc3',
      type: 'node',
      rootDir: ws,
      port: 20997,
      config: { type: 'node', rootDir: ws, port: 20997, main: 'index.js' },
    }),
    'tcp',
    'node adapter tanpa healthCheck eksplisit = tcp',
  );
});

