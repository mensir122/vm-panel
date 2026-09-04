// tests/unit/project-manager.test.js — unit test ProjectManager (node:test).
// Skenario: create (field lengkap + workspace dir), validasi name/type/port,
// getProject NOT_FOUND, update port ilegal, transisi ilegal,
// archive→restore→remove two-phase (confirmToken salah/benar, backup utuh).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessManager } from '../../manager/process_manager/index.js';
import { ProjectManager } from '../../manager/project_manager/index.js';
import {
  VmPanelError,
  VALIDATION,
  NOT_FOUND,
  PERMISSION_DENIED,
  PORT_ILLEGAL,
} from '../../lib/errors.js';

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-projm-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function makeManager(t, sandbox) {
  const dataDir = path.join(sandbox, 'data');
  const workspacesRoot = path.join(sandbox, 'workspaces');
  const runtimeDir = path.join(sandbox, 'runtime');
  const pm = new ProcessManager({ rootDir: runtimeDir });
  return new ProjectManager({ dataDir, workspacesRoot, processManager: pm });
}

test('createProject: record field lengkap + workspace dir dibuat', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  const rec = mgr.createProject({
    name: 'my-app',
    type: 'static',
    repoUrl: 'https://example.com/x.git',
    branch: 'develop',
    port: 21001,
    restartPolicy: 'always',
  });
  assert.ok(rec.id.startsWith('prj_'));
  assert.equal(rec.name, 'my-app');
  assert.equal(rec.type, 'static');
  assert.equal(rec.status, 'created');
  assert.equal(rec.repoUrl, 'https://example.com/x.git');
  assert.equal(rec.branch, 'develop');
  assert.equal(rec.port, 21001);
  assert.equal(rec.restartPolicy, 'always');
  assert.ok(rec.createdAt, 'createdAt ada');
  assert.ok(rec.updatedAt, 'updatedAt ada');
  // timestamps UTC ISO
  assert.match(rec.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  const wsExpected = path.join(sandbox, 'workspaces', rec.id);
  assert.equal(rec.workspacePath, wsExpected);
  assert.ok(fs.statSync(wsExpected).isDirectory(), 'workspace dir dibuat');
  mgr.close();
});

test('createProject: duplikat nama → VALIDATION', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  mgr.createProject({ name: 'dup-app', type: 'static' });
  assert.throws(
    () => mgr.createProject({ name: 'dup-app', type: 'static' }),
    (e) => e instanceof VmPanelError && e.code === VALIDATION,
  );
  mgr.close();
});

test('createProject: name invalid (UPPER, a, -x, 64 char) → VALIDATION', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  const invalidNames = ['UPPER', 'a', '-x', 'x'.repeat(64)];
  for (const name of invalidNames) {
    assert.throws(
      () => mgr.createProject({ name, type: 'static' }),
      (e) => e instanceof VmPanelError && e.code === VALIDATION,
      `name '${name}' harus ditolak`,
    );
  }
  mgr.close();
});

test('createProject: type invalid → VALIDATION', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  assert.throws(
    () => mgr.createProject({ name: 'type-bad', type: 'cobol' }),
    (e) => e instanceof VmPanelError && e.code === VALIDATION,
  );
  // 'custom' legal
  const rec = mgr.createProject({ name: 'type-custom-ok', type: 'custom' });
  assert.equal(rec.type, 'custom');
  mgr.close();
});

test('createProject: port ilegal → PORT_ILLEGAL', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  assert.throws(
    () => mgr.createProject({ name: 'port-bad', type: 'static', port: 80 }),
    (e) => e instanceof VmPanelError && e.code === PORT_ILLEGAL,
  );
  mgr.close();
});

test('getProject: not found → NOT_FOUND; id format invalid → VALIDATION', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  assert.throws(
    () => mgr.getProject('prj_AAAAAAAA01'),
    (e) => e instanceof VmPanelError && e.code === NOT_FOUND,
  );
  assert.throws(
    () => mgr.getProject('bukan-id'),
    (e) => e instanceof VmPanelError && e.code === VALIDATION,
  );
  mgr.close();
});

test('updateProject: port ilegal ditolak; patch aman menghasilkan diff {before, after}', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  const rec = mgr.createProject({ name: 'upd-app', type: 'static', branch: 'main' });
  assert.throws(
    () => mgr.updateProject(rec.id, { port: 80 }),
    (e) => e instanceof VmPanelError && e.code === PORT_ILLEGAL,
  );
  const diff = mgr.updateProject(rec.id, { branch: 'release', restartPolicy: 'always' });
  assert.equal(diff.before.branch, 'main');
  assert.equal(diff.after.branch, 'release');
  assert.equal(diff.after.restartPolicy, 'always');
  assert.equal(diff.before.id, diff.after.id);
  mgr.close();
});

test('setStatus: transisi ilegal created→running ditolak', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  const rec = mgr.createProject({ name: 'st-app', type: 'static' });
  assert.throws(
    () => mgr.setStatus(rec.id, 'running'),
    (e) => e instanceof VmPanelError && e.code === VALIDATION,
  );
  // legal: created→stopped
  const upd = mgr.setStatus(rec.id, 'stopped');
  assert.equal(upd.status, 'stopped');
  mgr.close();
});

test('archive → restore → remove: token salah → PERMISSION_DENIED; token benar → row hilang + workspace terhapus + backup utuh', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);

  // Dummy backup HARUS tetap ada setelah remove.
  const backupsDir = path.join(sandbox, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const backupFile = path.join(backupsDir, 'dummy-backup.tar.gz');
  fs.writeFileSync(backupFile, 'dummy-backup-content');

  const rec = mgr.createProject({ name: 'flow-app', type: 'static' });
  // created → stopped → archived
  mgr.setStatus(rec.id, 'stopped');
  const archived = mgr.archiveProject(rec.id);
  assert.equal(archived.status, 'archived');
  assert.ok(archived.archivedAt, 'archivedAt terisi');

  // restore: archived → stopped
  const restored = mgr.restoreProject(rec.id);
  assert.equal(restored.status, 'stopped');

  // archive lagi untuk remove
  mgr.archiveProject(rec.id);

  // remove dengan token SALAH → PERMISSION_DENIED
  assert.throws(
    () => mgr.removeProject(rec.id, { confirmToken: 'salah', expectedToken: 'benar' }),
    (e) => e instanceof VmPanelError && e.code === PERMISSION_DENIED,
  );
  // remove tanpa token → PERMISSION_DENIED
  assert.throws(
    () => mgr.removeProject(rec.id),
    (e) => e instanceof VmPanelError && e.code === PERMISSION_DENIED,
  );
  // row masih ada
  assert.equal(mgr.getProject(rec.id).id, rec.id);

  // remove dengan token BENAR
  const res = mgr.removeProject(rec.id, { confirmToken: 'benar', expectedToken: 'benar' });
  assert.equal(res.removed, true);
  // row hilang
  assert.throws(
    () => mgr.getProject(rec.id),
    (e) => e instanceof VmPanelError && e.code === NOT_FOUND,
  );
  // workspace terhapus
  assert.equal(fs.existsSync(rec.workspacePath), false, 'workspace folder terhapus');
  // backup TIDAK disentuh
  assert.equal(fs.existsSync(backupFile), true, 'backup harus tetap ada');
  assert.equal(fs.readFileSync(backupFile, 'utf8'), 'dummy-backup-content');
  mgr.close();
});

test('listProjects: filter status', (t) => {
  const sandbox = makeSandbox(t);
  const mgr = makeManager(t, sandbox);
  const a = mgr.createProject({ name: 'list-a', type: 'static' });
  mgr.createProject({ name: 'list-b', type: 'custom' });
  assert.equal(mgr.listProjects().length, 2);
  const stopped = mgr.listProjects({ status: 'stopped' });
  assert.equal(stopped.length, 0);
  mgr.setStatus(a.id, 'stopped');
  assert.equal(mgr.listProjects({ status: 'stopped' }).length, 1);
  mgr.close();
});
