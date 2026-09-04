// tests/unit/export-import.test.js — unit test ExportManager + ImportManager
// (node:test, sandbox tmp dengan DB nyata + rows). Skenario:
//   1. exportAll plaintext → file ada + inspect summary cocok (project names)
//   2. exportAll encrypted: inspect tanpa password → VALIDATION; password
//      salah → VALIDATION; password benar → summary ok
//   3. checksum: file truncated → VALIDATION
//   4. path safety: container jahat manual ('../evil', 'db/../../x', 'users.db')
//      → VALIDATION 'unexpected entry'
//   5. two-phase: tanpa token → PERMISSION_DENIED; token salah → PERMISSION_DENIED;
//      confirm→import → row yang dihapus setelah export kembali + rollback
//      point .pre-import-* ada
//   6. import payload DB corrupt → DB itu di-skip + warning, DB lokal utuh

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import { ExportManager } from '../../manager/export_manager/index.js';
import { ImportManager } from '../../manager/import_manager/index.js';
import { openDatabase } from '../../lib/db.js';
import { VmPanelError, VALIDATION, PERMISSION_DENIED, NOT_FOUND } from '../../lib/errors.js';

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-expimp-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Sandbox data dir dengan DB nyata: projects + services berisi rows dummy. */
function makeDataDir(t, sandbox) {
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const plt = openDatabase(path.join(dataDir, 'platform.db'), { schemaName: 'platform' });
  plt.migrate();
  plt.close();

  const prj = openDatabase(path.join(dataDir, 'projects.db'), { schemaName: 'projects' });
  prj.migrate();
  prj.tx(() => {
    prj.db
      .prepare(
        `INSERT INTO projects (id, name, type, status, branch, created_at, updated_at)
         VALUES (?, ?, ?, 'created', 'main', ?, ?)`,
      )
      .run('prj_TESTAAAAAA', 'alpha-app', 'static', new Date().toISOString(), new Date().toISOString());
    prj.db
      .prepare(
        `INSERT INTO projects (id, name, type, status, branch, created_at, updated_at)
         VALUES (?, ?, ?, 'created', 'main', ?, ?)`,
      )
      .run('prj_TESTBBBBBB', 'beta-app', 'node', new Date().toISOString(), new Date().toISOString());
  });
  prj.close();

  const svc = openDatabase(path.join(dataDir, 'services.db'), { schemaName: 'services' });
  svc.migrate();
  svc.tx(() => {
    svc.db
      .prepare(`INSERT INTO services (id, project_id, name, status) VALUES (?, ?, ?, 'stopped')`)
      .run('svc_TESTAAAAAA', 'prj_TESTAAAAAA', 'alpha-web');
  });
  svc.close();

  const dep = openDatabase(path.join(dataDir, 'deployments.db'), { schemaName: 'deployments' });
  dep.migrate();
  dep.close();

  const hlt = openDatabase(path.join(dataDir, 'health.db'), { schemaName: 'health' });
  hlt.migrate();
  hlt.close();

  const bak = openDatabase(path.join(dataDir, 'backups.db'), { schemaName: 'backups' });
  bak.migrate();
  bak.close();

  return dataDir;
}

function makeManagers(t, sandbox) {
  const dataDir = makeDataDir(t, sandbox);
  return {
    dataDir,
    exportMgr: new ExportManager({ dataDir }),
    importMgr: new ImportManager({ dataDir }),
  };
}

const code = (err) => (err instanceof VmPanelError ? err.code : null);

test('exportAll plaintext → file .vpe ada + inspect summary cocok (nama project benar)', (t) => {
  const sandbox = makeSandbox(t);
  const { dataDir, exportMgr, importMgr } = makeManagers(t, sandbox);
  const out = path.join(sandbox, 'export-all.vpe');
  const result = exportMgr.exportAll({ outputPath: out });

  assert.ok(fs.existsSync(out), 'file export dibuat');
  assert.equal(result.manifest.scope, 'all');
  assert.equal(result.manifest.encrypted, false);
  assert.ok(result.manifest.fileCount >= 7, '6 DB + registry'); // platform, projects, services, deployments, health, backups, registry
  assert.ok(result.manifest.fileCount <= 7, 'tanpa users.db/audit.db default');

  const summary = importMgr.inspectImport({ inputPath: out });
  assert.equal(summary.scope, 'all');
  assert.equal(summary.encrypted, false);
  assert.deepEqual(
    summary.projects.map((p) => p.name).sort(),
    ['alpha-app', 'beta-app'],
  );
  assert.equal(summary.servicesCount, 1);
  assert.ok(summary.files.some((f) => f.path === 'db/projects.db'));
  assert.ok(summary.files.some((f) => f.path === 'registry/export-registry.json'));
  assert.ok(summary.files.every((f) => !f.path.includes('users.db')), 'users.db tidak di-export');
  assert.ok(summary.files.every((f) => !f.path.includes('audit.db')), 'audit.db tidak di-export default');
  void dataDir;
});

test('exportProject: scope project + registry terfilter; project tak ada → NOT_FOUND', (t) => {
  const sandbox = makeSandbox(t);
  const { exportMgr, importMgr } = makeManagers(t, sandbox);
  const out = path.join(sandbox, 'export-prj.vpe');
  exportMgr.exportProject({ projectId: 'prj_TESTAAAAAA', outputPath: out });

  const summary = importMgr.inspectImport({ inputPath: out });
  assert.equal(summary.scope, 'project');
  assert.deepEqual(summary.projectIds, ['prj_TESTAAAAAA']);
  assert.deepEqual(summary.projects.map((p) => p.name), ['alpha-app']);
  assert.equal(summary.servicesCount, 1);

  assert.throws(
    () => exportMgr.exportProject({ projectId: 'prj_NOTEXIST01', outputPath: path.join(sandbox, 'x.vpe') }),
    (e) => code(e) === NOT_FOUND,
  );
});

test('exportAll encrypted: tanpa password → VALIDATION; password salah → VALIDATION; benar → summary ok', (t) => {
  const sandbox = makeSandbox(t);
  const { exportMgr, importMgr } = makeManagers(t, sandbox);
  const out = path.join(sandbox, 'export-enc.vpe');

  assert.throws(
    () => exportMgr.exportAll({ outputPath: out, encrypted: true }),
    (e) => code(e) === VALIDATION,
    'encrypted tanpa password → VALIDATION',
  );

  exportMgr.exportAll({ outputPath: out, encrypted: true, password: 's3cret-pass' });
  assert.ok(fs.existsSync(out));

  assert.throws(
    () => importMgr.inspectImport({ inputPath: out }),
    (e) => code(e) === VALIDATION,
    'inspect tanpa password → VALIDATION',
  );
  assert.throws(
    () => importMgr.inspectImport({ inputPath: out, password: 'wrong-password' }),
    (e) => code(e) === VALIDATION,
    'password salah → VALIDATION (decrypt failed)',
  );

  const summary = importMgr.inspectImport({ inputPath: out, password: 's3cret-pass' });
  assert.equal(summary.encrypted, true);
  assert.equal(summary.scope, 'all');
  assert.deepEqual(summary.projects.map((p) => p.name).sort(), ['alpha-app', 'beta-app']);
});

test('checksum: file export di-truncate → VALIDATION (bukan gzip valid)', (t) => {
  const sandbox = makeSandbox(t);
  const { exportMgr, importMgr } = makeManagers(t, sandbox);
  const out = path.join(sandbox, 'export-trunc.vpe');
  exportMgr.exportAll({ outputPath: out });

  const raw = fs.readFileSync(out);
  fs.writeFileSync(out, raw.subarray(0, Math.floor(raw.length / 2))); // corrupt/truncate
  assert.throws(
    () => importMgr.inspectImport({ inputPath: out }),
    (e) => code(e) === VALIDATION,
  );
});

test('checksum tamper: gzip valid tapi payload byte di-flip → VALIDATION', (t) => {
  const sandbox = makeSandbox(t);
  const { exportMgr, importMgr } = makeManagers(t, sandbox);
  const out = path.join(sandbox, 'export-tamper.vpe');
  exportMgr.exportAll({ outputPath: out });

  // Decompress → flip satu byte payload → re-gzip (checksum manifest tak cocok lagi)
  const container = JSON.parse(zlib.gunzipSync(fs.readFileSync(out)).toString('utf8'));
  const key = 'db/projects.db';
  const buf = Buffer.from(container.payload[key].b64, 'base64');
  buf[100] = buf[100] ^ 0xff;
  container.payload[key].b64 = buf.toString('base64');
  fs.writeFileSync(out, zlib.gzipSync(Buffer.from(JSON.stringify(container))));

  assert.throws(
    () => importMgr.inspectImport({ inputPath: out }),
    (e) => code(e) === VALIDATION && /checksum mismatch/i.test(e.message),
    'checksum mismatch terdeteksi',
  );
});

test('path safety: container jahat manual → VALIDATION unexpected entry', (t) => {
  const sandbox = makeSandbox(t);
  const { importMgr } = makeManagers(t, sandbox);
  const evil = path.join(sandbox, 'evil.vpe');

  const build = (paths) =>
    zlib.gzipSync(
      Buffer.from(
        JSON.stringify({
          magic: 'VPEXPORT1',
          manifest: {
            version: 1,
            scope: 'all',
            createdAt: new Date().toISOString(),
            projectIds: [],
            encrypted: false,
            files: paths.map((p) => ({ path: p, size: 1, sha256: 'x' })),
          },
          payload: Object.fromEntries(paths.map((p) => [p, { b64: Buffer.from('x').toString('base64') }])),
        }),
      ),
    );

  for (const paths of [
    ['../evil'],
    ['db/../../x'],
    ['db/users.db'],
    ['foo/bar.txt'],
    ['C:/win/system32/x'],
    ['db\\projects.db'],
  ]) {
    fs.writeFileSync(evil, build(paths));
    assert.throws(
      () => importMgr.inspectImport({ inputPath: evil }),
      (e) => code(e) === VALIDATION && /unexpected entry/i.test(e.message),
      `path jahat harus ditolak: ${paths[0]}`,
    );
  }
});

test('two-phase: tanpa token → PERMISSION_DENIED; token salah → PERMISSION_DENIED', (t) => {
  const sandbox = makeSandbox(t);
  const { exportMgr, importMgr } = makeManagers(t, sandbox);
  const out = path.join(sandbox, 'export-tf.vpe');
  exportMgr.exportAll({ outputPath: out });

  assert.throws(
    () => importMgr.importAll({ inputPath: out, expectedToken: 'IMPORT' }),
    (e) => code(e) === PERMISSION_DENIED,
    'tanpa confirmToken → PERMISSION_DENIED',
  );
  assert.throws(
    () =>
      importMgr.importAll({
        inputPath: out,
        confirmToken: 'deadbeef'.repeat(4),
        expectedToken: 'IMPORT',
      }),
    (e) => code(e) === PERMISSION_DENIED,
    'token tidak dikenal → PERMISSION_DENIED',
  );
  const { confirmToken } = importMgr.confirmImport({ inputPath: out });
  assert.throws(
    () =>
      importMgr.importAll({
        inputPath: out,
        confirmToken,
        expectedToken: 'WRONG',
      }),
    (e) => code(e) === PERMISSION_DENIED,
    'expectedToken salah → PERMISSION_DENIED',
  );
});

test('confirm → import → row yang dihapus setelah export kembali + rollback point ada', (t) => {
  const sandbox = makeSandbox(t);
  const { dataDir, exportMgr, importMgr } = makeManagers(t, sandbox);
  const out = path.join(sandbox, 'export-roundtrip.vpe');
  exportMgr.exportAll({ outputPath: out });

  // Simulasi kerusakan: hapus row project 'alpha-app' + service setelah export
  const prj = openDatabase(path.join(dataDir, 'projects.db'), { schemaName: 'projects' });
  prj.db.prepare("DELETE FROM projects WHERE id = 'prj_TESTAAAAAA'").run();
  prj.close();
  const svc = openDatabase(path.join(dataDir, 'services.db'), { schemaName: 'services' });
  svc.db.prepare('DELETE FROM services').run();
  svc.close();

  const { confirmToken, expectedPhrase, summary } = importMgr.confirmImport({ inputPath: out });
  assert.equal(expectedPhrase, 'IMPORT');
  assert.equal(summary.projects.length, 2);

  const report = importMgr.importAll({
    inputPath: out,
    confirmToken,
    expectedToken: 'IMPORT',
    actor: 'test',
  });

  assert.ok(report.restored.includes('projects.db'), 'projects.db di-restore');
  assert.ok(report.restored.includes('services.db'), 'services.db di-restore');
  assert.ok(fs.existsSync(report.rollbackPoint), 'rollback point .pre-import-* ada');

  // Data row kembali
  const check = openDatabase(path.join(dataDir, 'projects.db'), { schemaName: 'projects' });
  try {
    const row = check.db.prepare('SELECT name FROM projects WHERE id = ?').get('prj_TESTAAAAAA');
    assert.equal(row?.name, 'alpha-app', 'row terhapus kembali setelah import');
  } finally {
    check.close();
  }
  const checkSvc = openDatabase(path.join(dataDir, 'services.db'), { schemaName: 'services' });
  try {
    const n = checkSvc.db.prepare('SELECT COUNT(*) AS n FROM services').get().n;
    assert.equal(n, 1, 'service row kembali');
  } finally {
    checkSvc.close();
  }

  // Token one-shot: reuse → PERMISSION_DENIED
  assert.throws(
    () => importMgr.importAll({ inputPath: out, confirmToken, expectedToken: 'IMPORT' }),
    (e) => code(e) === PERMISSION_DENIED,
    'confirmToken one-shot',
  );
});

test('import dengan payload DB corrupt → DB itu di-skip + warning, DB lokal tidak rusak', (t) => {
  const sandbox = makeSandbox(t);
  const { dataDir, exportMgr, importMgr } = makeManagers(t, sandbox);

  // Buat container manual: services.db bytes RUSAK, projects.db bytes valid
  const servicesBytes = fs.readFileSync(path.join(dataDir, 'services.db'));
  const projectsBytes = fs.readFileSync(path.join(dataDir, 'projects.db'));
  const corrupted = Buffer.from(servicesBytes);
  corrupted.write('NOT-SQLITE-FORMAT', 0, 'latin1'); // header dirusak

  const payload = {
    'db/services.db': { b64: corrupted.toString('base64') },
    'db/projects.db': { b64: projectsBytes.toString('base64') },
    'registry/export-registry.json': {
      b64: Buffer.from(
        JSON.stringify({
          exportedAt: new Date().toISOString(),
          scope: 'all',
          counts: { projects: 0, services: 0 },
          projects: [],
          services: [],
        }),
      ).toString('base64'),
    },
  };
  const files = Object.entries(payload).map(([p, v]) => ({
    path: p,
    size: Buffer.from(v.b64, 'base64').length,
    sha256: createHash('sha256').update(Buffer.from(v.b64, 'base64')).digest('hex'),
  }));

  // Hapus service row lokal sebagai penanda: kalau services.db di-restore (bug),
  // row tetap 0; tapi yang benar services.db harus di-skip → tambah row penanda dulu.
  const svc = openDatabase(path.join(dataDir, 'services.db'), { schemaName: 'services' });
  svc.tx(() => {
    svc.db
      .prepare(`INSERT INTO services (id, project_id, name, status) VALUES ('svc_MARKER000', 'prj_TESTAAAAAA', 'marker', 'stopped')`)
      .run();
  });
  svc.close();

  const container = {
    magic: 'VPEXPORT1',
    manifest: {
      version: 1,
      scope: 'all',
      createdAt: new Date().toISOString(),
      appVersion: 'test',
      projectIds: ['prj_TESTAAAAAA'],
      encrypted: false,
      files,
      containsDbSnapshots: true,
    },
    payload,
  };
  const out = path.join(sandbox, 'corrupt-partial.vpe');
  fs.writeFileSync(out, zlib.gzipSync(Buffer.from(JSON.stringify(container))));

  const { confirmToken } = importMgr.confirmImport({ inputPath: out });
  const report = importMgr.importAll({ inputPath: out, confirmToken, expectedToken: 'IMPORT' });

  assert.ok(report.skipped.some((s) => s.file === 'services.db'), 'services.db corrupt di-skip');
  assert.ok(report.warnings.some((w) => w.includes('services.db')), 'warning skip muncul');
  assert.ok(report.restored.includes('projects.db'), 'projects.db valid tetap di-restore');

  // DB lokal services.db tidak rusak — row penanda masih ada
  const verify = openDatabase(path.join(dataDir, 'services.db'), { schemaName: 'services' });
  try {
    const row = verify.db.prepare('SELECT name FROM services WHERE id = ?').get('svc_MARKER000');
    assert.equal(row?.name, 'marker', 'services.db lokal tidak tertimpa corrupt bytes');
  } finally {
    verify.close();
  }
});
