// tests/unit/backup-restore.test.js — unit test BackupManager + RestoreManager
// (docs/DESIGN.md §9.1-9.5, D9c, §5.5). Sandbox tmp: dataDir berisi DB nyata
// (openDatabase + migrate + beberapa row), backupsRoot tmp.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../lib/db.js';
import { BackupManager } from '../../manager/backup_manager/index.js';
import { RestoreManager } from '../../manager/restore_manager/index.js';
import { VmPanelError, BACKUP_IN_PROGRESS, NOT_FOUND, VALIDATION } from '../../lib/errors.js';

/** rmSync best-effort dengan retry — AV/indexer Windows sesekali mengunci
 * path; kegagalan cleanup tmp TIDAK boleh menggagalkan test fungsional. */
function rmWithRetry(p, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch (e) {
      lastErr = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
    }
  }
  console.warn(`[test] cleanup tmp gagal (dibiarkan): ${p} — ${lastErr?.code ?? lastErr}`);
}

/** Sandbox tmp: dataDir (3 DB nyata + config.yaml) + backupsRoot. */
function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-backup-'));
  const closers = []; // fungsi close handle DB — WAJIB jalan sebelum rm
  t.after(() => {
    for (const fn of closers.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
    rmWithRetry(root);
  });
  const dataDir = path.join(root, 'data');
  const backupsRoot = path.join(root, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });

  const platform = openDatabase(path.join(dataDir, 'platform.db'), { schemaName: 'platform' });
  platform.migrate();
  platform.setMeta('probe_key', 'platform-value-1');
  platform.close();

  const projects = openDatabase(path.join(dataDir, 'projects.db'), { schemaName: 'projects' });
  projects.migrate();
  projects.db
    .prepare(
      `INSERT INTO projects (id, name, type, status, created_at)
       VALUES ('prj_TESTAAAAAA', 'app-one', 'static', 'running', '2026-01-01T00:00:00Z')`,
    )
    .run();
  projects.close();

  const locks = openDatabase(path.join(dataDir, 'locks.db'), { schemaName: 'locks' });
  locks.migrate();
  locks.close();

  fs.writeFileSync(path.join(dataDir, 'config.yaml'), 'manager:\n  apiPort: 8097\n');
  return { root, dataDir, backupsRoot, closers };
}

function makeManagers(sandbox, nowFn) {
  const bm = new BackupManager({
    dataDir: sandbox.dataDir,
    backupsRoot: sandbox.backupsRoot,
    lockDir: path.join(sandbox.root, 'locks'),
    nowFn,
  });
  const rm = new RestoreManager({
    dataDir: sandbox.dataDir,
    backupsRoot: sandbox.backupsRoot,
    backupManager: bm,
  });
  sandbox.closers.push(() => bm.close());
  return { bm, rm };
}

function readProjectsCount(dataDir) {
  const p = openDatabase(path.join(dataDir, 'projects.db'), { schemaName: 'projects' });
  const c = p.db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  p.close();
  return c;
}

test('createBackup manual: manifest lengkap + files ter-gzip + row backups.db + verify valid', async (t) => {
  const sandbox = makeSandbox(t);
  const { bm } = makeManagers(sandbox);
  t.after(() => bm.close());

  const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  assert.ok(res.backupId.startsWith('bak_'));
  assert.equal(path.basename(res.path), res.backupId);
  assert.equal(path.basename(path.dirname(res.path)), 'manual');

  const m = JSON.parse(fs.readFileSync(path.join(res.path, 'manifest.json'), 'utf8'));
  assert.equal(m.version, 1);
  assert.equal(m.backupId, res.backupId);
  assert.equal(m.trigger, 'manual');
  assert.equal(m.retentionClass, 'manual');
  assert.match(m.createdAt, /Z$/); // UTC ISO
  assert.equal(m.epoch, '1'); // backupset_epoch dari platform.db
  assert.ok(Array.isArray(m.files) && m.files.length >= 3);

  for (const f of m.files) {
    const gz = fs.readFileSync(path.join(res.path, ...f.relPath.split('/')));
    assert.equal(gz[0], 0x1f, 'gzip magic byte 1');
    assert.equal(gz[1], 0x8b, 'gzip magic byte 2');
  }

  const plat = m.files.find((f) => f.relPath === 'files/platform.db.gz');
  assert.ok(plat, 'platform.db.gz ada di manifest');
  const rawPlat = zlib.gunzipSync(fs.readFileSync(path.join(res.path, 'files/platform.db.gz')));
  assert.equal(rawPlat.length, plat.size);
  assert.equal(createHash('sha256').update(rawPlat).digest('hex'), plat.sha256);
  assert.ok(m.totalSize > 1024, 'totalSize > 1KB');
  assert.equal(m.dbs.platform, 'ok');
  assert.equal(m.dbs.projects, 'ok');

  const bk = bm._backupsDb();
  const row = bk.db.prepare('SELECT * FROM backups WHERE id = ?').get(res.backupId);
  assert.ok(row, 'row backups.db ada');
  assert.equal(row.project_id, null);
  assert.equal(row.trigger, 'manual');
  assert.equal(row.upload_status, 'local');
  assert.equal(row.retention_class, 'manual');
  assert.equal(row.runner_id, 'local');
  assert.equal(row.sha256, m.totalSha256);
  const items = bk.db.prepare('SELECT * FROM backup_items WHERE backup_id = ?').all(res.backupId);
  assert.equal(items.length, m.files.length);

  const ver = await bm.verifyBackup(res.backupId);
  assert.equal(ver.ok, true, `verify ok: ${ver.error}`);
  const row2 = bk.db.prepare('SELECT verification_status FROM backups WHERE id = ?').get(res.backupId);
  assert.equal(row2.verification_status, 'valid');
});

test('verifyBackup tamper: modifikasi 1 byte file .gz → verification failed', async (t) => {
  const sandbox = makeSandbox(t);
  const { bm } = makeManagers(sandbox);
  t.after(() => bm.close());

  const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  const target = path.join(res.path, 'files', 'projects.db.gz');
  const buf = fs.readFileSync(target);
  buf[buf.length - 1] ^= 0xff; // tamper 1 byte
  fs.writeFileSync(target, buf);

  const ver = await bm.verifyBackup(res.backupId);
  assert.equal(ver.ok, false);
  assert.match(ver.error, /sha256 mismatch|gzip corrupt/);
  const row = bm._backupsDb().db.prepare('SELECT verification_status FROM backups WHERE id = ?').get(res.backupId);
  assert.equal(row.verification_status, 'failed');
});

test('rate-limit: scheduled kedua < 30 menit → BACKUP_IN_PROGRESS, manual tetap boleh', async (t) => {
  const sandbox = makeSandbox(t);
  const { bm } = makeManagers(sandbox);
  t.after(() => bm.close());

  await bm.createBackup({ trigger: 'scheduled', retentionClass: 'latest' });
  await assert.rejects(
    () => bm.createBackup({ trigger: 'scheduled', retentionClass: 'latest' }),
    (e) => e instanceof VmPanelError && e.code === BACKUP_IN_PROGRESS,
  );
  const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  assert.ok(res.backupId.startsWith('bak_'), 'manual selalu boleh');
  await assert.rejects(
    () => bm.createBackup({ trigger: 'pre-shutdown', retentionClass: 'latest' }),
    (e) => e instanceof VmPanelError && e.code === BACKUP_IN_PROGRESS,
  );
});

test('retention: 5 backup latest → tinggal 3 terbaru, manual tidak tersentuh, retention_runs tercatat', async (t) => {
  const sandbox = makeSandbox(t);
  let now = Date.parse('2026-03-01T00:00:00Z');
  const { bm } = makeManagers(sandbox, () => now);
  t.after(() => bm.close());

  await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  const latestIds = [];
  for (let i = 0; i < 5; i++) {
    now += 31 * 60 * 1000; // +31 menit per backup — lolos rate-limit
    latestIds.push((await bm.createBackup({ trigger: 'scheduled', retentionClass: 'latest' })).backupId);
  }

  const out = await bm.applyRetention({ latest: 3, daily: 7, weekly: 4 });
  assert.equal(out.perClass.latest.deleted, 2);
  assert.equal(out.perClass.latest.kept, 3);
  assert.equal(out.perClass.daily.deleted, 0);
  assert.equal(out.perClass.weekly.deleted, 0);

  // rows DESC = [b5,b4,b3,b2,b1]; keep 3 → excess (expired) = [b1,b2]
  for (const id of latestIds.slice(0, 2)) {
    const row = bm._backupsDb().db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    assert.equal(row.verification_status, 'expired');
    assert.equal(row.error, 'expired by retention');
    assert.ok(!fs.existsSync(row.file_path), 'direktori backup lama dihapus');
  }
  for (const id of latestIds.slice(2)) {
    const row = bm._backupsDb().db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    assert.equal(row.verification_status, 'valid');
    assert.ok(fs.existsSync(row.file_path), 'direktori 3 terbaru masih ada');
  }

  const manual = bm.listBackups({ retentionClass: 'manual' });
  assert.equal(manual.length, 1);
  assert.equal(manual[0].verification_status, 'valid');
  assert.ok(fs.existsSync(manual[0].file_path), 'manual tidak tersentuh');

  const runs = bm._backupsDb().db.prepare('SELECT * FROM retention_runs ORDER BY rowid').all();
  assert.ok(runs.length >= 3, 'satu row retention_runs per kelas');
  const latestRun = runs.find((r) => r.class === 'latest');
  assert.equal(latestRun.deleted_count, 2);
  assert.equal(latestRun.kept_count, 3);
  assert.equal(JSON.parse(latestRun.detail).length, 2);
});

test('restore dryRun: laporan tanpa mengubah DB asli', async (t) => {
  const sandbox = makeSandbox(t);
  const { bm, rm } = makeManagers(sandbox);
  t.after(() => bm.close());

  const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  bm.verifyBackup(res.backupId);

  const report = await rm.restoreBackup(res.backupId, { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.ok(report.restored.includes('platform'));
  assert.ok(report.restored.includes('projects'));
  assert.ok(report.restored.includes('locks'));
  assert.equal(report.rollbackDir, null);
  assert.deepEqual(report.skipped, []);

  // DB asli tidak berubah + tidak ada artefak restore di dataDir
  assert.equal(readProjectsCount(sandbox.dataDir), 1);
  const artifacts = fs
    .readdirSync(sandbox.dataDir)
    .filter((f) => f.startsWith('.restore') || f.includes('pre-restore'));
  assert.deepEqual(artifacts, [], 'tidak ada staging/rollback tersisa');
});

test('restore nyata: data kembali ke snapshot + file .pre-restore ada', async (t) => {
  const sandbox = makeSandbox(t);
  const { bm, rm } = makeManagers(sandbox);
  t.after(() => bm.close());

  const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  bm.verifyBackup(res.backupId);

  // Mutasi data SETELAH backup
  const projects = openDatabase(path.join(sandbox.dataDir, 'projects.db'), { schemaName: 'projects' });
  projects.db
    .prepare(
      `INSERT INTO projects (id, name, type, status, created_at)
       VALUES ('prj_TESTBBBBBB', 'app-two', 'node', 'running', '2026-02-01T00:00:00Z')`,
    )
    .run();
  projects.close();
  const platform = openDatabase(path.join(sandbox.dataDir, 'platform.db'), { schemaName: 'platform' });
  platform.setMeta('probe_key', 'CHANGED-AFTER-BACKUP');
  platform.close();

  const report = await rm.restoreBackup(res.backupId, { dryRun: false });
  assert.equal(report.dryRun, false);
  assert.ok(report.restored.includes('projects'));
  assert.ok(report.restored.includes('platform'));
  assert.ok(report.rollbackDir, 'rollbackDir dilaporkan');

  // Data kembali ke snapshot
  assert.equal(readProjectsCount(sandbox.dataDir), 1);
  const p2 = openDatabase(path.join(sandbox.dataDir, 'projects.db'), { schemaName: 'projects' });
  const ids = p2.db.prepare('SELECT id FROM projects ORDER BY id').all().map((r) => r.id);
  p2.close();
  assert.deepEqual(ids, ['prj_TESTAAAAAA'], 'app-two hilang, snapshot kembali');

  const plat2 = openDatabase(path.join(sandbox.dataDir, 'platform.db'), { schemaName: 'platform' });
  assert.equal(plat2.getMeta('probe_key'), 'platform-value-1');
  plat2.close();

  // Rollback point: <name>.db.pre-restore-<token> berisi DB LAMA (2 rows)
  const rolled = fs.readdirSync(report.rollbackDir).filter((f) => f.includes('.pre-restore'));
  assert.ok(rolled.length >= 2, `pre-restore files ada: ${rolled.join(',')}`);
  const rolledProjects = rolled.find((f) => f.startsWith('projects.db'));
  assert.ok(rolledProjects, 'projects.db.pre-restore ada');
  const oldDb = openDatabase(path.join(report.rollbackDir, rolledProjects), { schemaName: 'projects' });
  const oldCount = oldDb.db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  oldDb.close();
  assert.equal(oldCount, 2, 'rollback point memuat DB lama');

  // Staging dibersihkan
  const leftovers = fs.readdirSync(sandbox.dataDir).filter((f) => f.startsWith('.restore-staging'));
  assert.deepEqual(leftovers, []);
});

test('restore backup corrupt (verification failed) → VALIDATION', async (t) => {
  const sandbox = makeSandbox(t);
  const { bm, rm } = makeManagers(sandbox);
  t.after(() => bm.close());

  const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  // Tamper file .gz → verify gagal → row 'failed'
  const target = path.join(res.path, 'files', 'platform.db.gz');
  const buf = fs.readFileSync(target);
  buf[10] ^= 0xff;
  fs.writeFileSync(target, buf);
  const ver = await bm.verifyBackup(res.backupId);
  assert.equal(ver.ok, false);

  assert.throws(
    () => rm.restoreBackup(res.backupId, { dryRun: false }),
    (e) =>
      e instanceof VmPanelError &&
      e.code === VALIDATION &&
      /backup not verified/i.test(e.message),
  );
  // DB asli tidak tersentuh
  assert.equal(readProjectsCount(sandbox.dataDir), 1);
});

test('restore: backup id tidak dikenal → NOT_FOUND; readManifest/listBackups jalan', async (t) => {
  const sandbox = makeSandbox(t);
  const { bm, rm } = makeManagers(sandbox);
  t.after(() => bm.close());

  const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  bm.verifyBackup(res.backupId);

  assert.throws(
    () => rm.restoreBackup('bak_TIDAKADA1', { dryRun: true }),
    (e) => e instanceof VmPanelError && e.code === NOT_FOUND,
  );

  const m = bm.readManifest(res.backupId);
  assert.equal(m.backupId, res.backupId);
  const rows = bm.listBackups({ retentionClass: 'manual', limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, res.backupId);
});
