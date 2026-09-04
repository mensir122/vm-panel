// tests/unit/schema.test.js — DDL 9 DB valid + trigger audit abort (node:test)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMAS, SCHEMA_NAMES } from '../../lib/schema.js';

describe('schema.js — definisi DDL', () => {
  test('SCHEMAS berisi tepat 9 database dengan nama yang diharapkan', () => {
    assert.deepEqual(SCHEMA_NAMES, [
      'platform',
      'projects',
      'services',
      'deployments',
      'health',
      'backups',
      'audit',
      'users',
      'locks',
    ]);
  });

  test('setiap DB diawali schema_migrations + meta + init backupset_epoch=1', () => {
    for (const name of SCHEMA_NAMES) {
      const stmts = SCHEMAS[name];
      assert.ok(stmts.length >= 3, `${name}: minimal 3 statement dasar`);
      assert.match(stmts[0].sql, /CREATE TABLE IF NOT EXISTS schema_migrations/);
      assert.match(stmts[1].sql, /CREATE TABLE IF NOT EXISTS meta/);
      assert.match(stmts[2].sql, /backupset_epoch/);
      assert.match(stmts[2].sql, /WHERE NOT EXISTS/);
    }
  });

  test('projects memiliki 25+ field sesuai §5.3', () => {
    const stmt = SCHEMAS.projects.find((s) => s.name === 'create_projects');
    assert.ok(stmt, 'create_projects ada');
    const cols = stmt.sql
      .split('\n')
      .map((l) => l.trim().match(/^([a-z_]+)\s+(TEXT|INTEGER|REAL|BLOB)/i))
      .filter(Boolean).length;
    assert.ok(cols >= 25, `projects kolom = ${cols}, harus >= 25`);
  });

  test('audit memiliki trigger no_delete dan no_update yang RAISE(ABORT)', () => {
    const trigDelete = SCHEMAS.audit.find((s) => s.name === 'trigger_audit_no_delete');
    const trigUpdate = SCHEMAS.audit.find((s) => s.name === 'trigger_audit_no_update');
    assert.ok(trigDelete, 'trigger no_delete ada');
    assert.ok(trigUpdate, 'trigger no_update ada');
    assert.match(trigDelete.sql, /BEFORE DELETE ON audit_events/);
    assert.match(trigDelete.sql, /RAISE\(ABORT/);
    assert.match(trigUpdate.sql, /BEFORE UPDATE ON audit_events/);
    assert.match(trigUpdate.sql, /RAISE\(ABORT/);
  });
});

describe('schema.js — eksekusi DDL nyata (in-memory, per DB)', () => {
  test('semua 9 DB: DDL valid, meta backupset_epoch=1, migrasi tercatat', async () => {
    const { default: Database } = await import('better-sqlite3');
    for (const name of SCHEMA_NAMES) {
      const db = new Database(':memory:');
      try {
        for (const stmt of SCHEMAS[name]) db.exec(stmt.sql);

        // tabel wajib ada di setiap DB
        for (const tbl of ['schema_migrations', 'meta']) {
          const row = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(tbl);
          assert.ok(row, `${name}: tabel ${tbl} ada`);
        }

        // backupset_epoch = 1
        const epoch = db
          .prepare("SELECT value FROM meta WHERE key='backupset_epoch'")
          .get();
        assert.equal(epoch.value, '1', `${name}: backupset_epoch=1`);

        // tabel domain utama ada
        const domainTables = {
          platform: ['runner_state', 'storage_stats'],
          projects: ['projects', 'project_env_refs', 'workspaces'],
          services: ['services', 'service_supervisor_state', 'deployment_queue', 'ports'],
          deployments: ['deployments', 'deployment_events', 'revisions'],
          health: ['health_checks', 'health_state', 'alerts'],
          backups: ['backups', 'backup_items', 'retention_runs'],
          audit: ['audit_events'],
          users: ['users', 'sessions', 'recovery_codes'],
          locks: ['lock_registry', 'lock_events'],
        };
        for (const tbl of domainTables[name]) {
          const row = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(tbl);
          assert.ok(row, `${name}: tabel ${tbl} ada`);
        }
      } finally {
        db.close();
      }
    }
  });

  test('audit_events: DELETE dan UPDATE di-abort oleh trigger', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    try {
      for (const stmt of SCHEMAS.audit) db.exec(stmt.sql);
      db.prepare(
        'INSERT INTO audit_events (at, actor, operation, result) VALUES (?, ?, ?, ?)',
      ).run('2026-01-01T00:00:00Z', 'tester', 'op.test', 'ok');

      assert.throws(() => db.prepare('DELETE FROM audit_events').run(), /append-only/);
      assert.throws(
        () => db.prepare('UPDATE audit_events SET result=?').run('x'),
        /append-only/,
      );
      // INSERT tetap boleh (append-only)
      db.prepare(
        'INSERT INTO audit_events (at, actor, operation, result) VALUES (?, ?, ?, ?)',
      ).run('2026-01-01T00:00:01Z', 'tester', 'op.test2', 'ok');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_events').get().c, 2);
    } finally {
      db.close();
    }
  });
});
