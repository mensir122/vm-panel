// tests/unit/db.test.js — open/migrate/integrity/vacuumInto/preflight/tx (node:test)
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, preflightCheck } from '../../lib/db.js';
import { SCHEMAS, SCHEMA_NAMES } from '../../lib/schema.js';

const tmpRoot = join(tmpdir(), 'vmpanel-db-test');
mkdirSync(tmpRoot, { recursive: true });
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpRoot, 'run-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase — pragmas & API', () => {
  test('journal_mode WAL, busy_timeout 5000, foreign_keys ON', () => {
    const path = join(dir, 'platform.db');
    const h = openDatabase(path, { schemaName: 'platform' });
    try {
      assert.equal(h.db.pragma('journal_mode', { simple: true }), 'wal');
      const bt = h.db.pragma('busy_timeout', { simple: true });
      assert.equal(bt, 5000);
      assert.equal(h.db.pragma('foreign_keys', { simple: true }), 1);
    } finally {
      h.close();
    }
  });

  test('migrate() idempotent: dua kali → jumlah baris schema_migrations sama', () => {
    const h = openDatabase(join(dir, 'projects.db'), { schemaName: 'projects' });
    try {
      h.migrate();
      const count1 = h.db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
      h.migrate();
      const count2 = h.db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
      assert.equal(count1, SCHEMAS.projects.length);
      assert.equal(count1, count2);
      // meta ter-inisialisasi
      assert.equal(h.getMeta('backupset_epoch'), '1');
      h.setMeta('backupset_epoch', '2');
      assert.equal(h.getMeta('backupset_epoch'), '2');
      h.setMeta('custom_key', 'x');
      assert.equal(h.getMeta('custom_key'), 'x');
    } finally {
      h.close();
    }
  });

  test('integrityCheck() ok setelah migrate', () => {
    const h = openDatabase(join(dir, 'health.db'), { schemaName: 'health' });
    try {
      h.migrate();
      const r = h.integrityCheck();
      assert.equal(r.ok, true);
      assert.equal(r.details.quick_check[0].quick_check, 'ok');
      assert.equal(r.details.foreign_key_check.length, 0);
    } finally {
      h.close();
    }
  });

  test('tx(fn) — BEGIN IMMEDIATE helper, rollback saat throw', () => {
    const h = openDatabase(join(dir, 'users.db'), { schemaName: 'users' });
    try {
      h.migrate();
      h.tx(() => {
        h.db
          .prepare('INSERT INTO users (id, username, created_at) VALUES (?,?,?)')
          .run('u1', 'alice', '2026-01-01T00:00:00Z');
      });
      assert.throws(() =>
        h.tx(() => {
          h.db
            .prepare('INSERT INTO users (id, username, created_at) VALUES (?,?,?)')
            .run('u2', 'bob', '2026-01-01T00:00:00Z');
          throw new Error('boom');
        }),
      );
      const n = h.db.prepare('SELECT COUNT(*) c FROM users').get().c;
      assert.equal(n, 1, 'rollback bekerja');
    } finally {
      h.close();
    }
  });
});

describe('openDatabase — vacuumInto', () => {
  test('snapshot valid; target yang sudah ada → VACUUM_TARGET_EXISTS', async () => {
    const src = join(dir, 'backups.db');
    const h = openDatabase(src, { schemaName: 'backups' });
    const target = join(dir, 'snapshot.db');
    try {
      h.migrate();
      h.db
        .prepare('INSERT INTO backups (id, project_id, at, trigger) VALUES (?,?,?,?)')
        .run('b1', 'p1', '2026-01-01T00:00:00Z', 'manual');

      h.vacuumInto(target);
      assert.ok(existsSync(target));

      // snapshot terbaca & berisi data
      const Database = (await import('better-sqlite3')).default;
      const snap = new Database(target);
      try {
        assert.equal(
          snap.prepare('SELECT COUNT(*) c FROM backups').get().c,
          1,
        );
      } finally {
        snap.close();
      }

      // target sudah ada → tolak (gotcha VACUUM INTO)
      assert.throws(
        () => h.vacuumInto(target),
        (e) => e.code === 'VACUUM_TARGET_EXISTS',
      );
    } finally {
      h.close();
    }
  });
});

describe('preflight — refuse-start & WAL yatim', () => {
  test('file 0-byte → REFUSE_START_DB, tidak auto-delete', () => {
    const p = join(dir, 'zero.db');
    writeFileSync(p, '');
    assert.throws(
      () => preflightCheck(p),
      (e) => e.code === 'REFUSE_START_DB' && e.reason === 'empty_file',
    );
    assert.ok(existsSync(p), 'file tidak boleh dihapus otomatis');
  });

  test('header bukan SQLite → REFUSE_START_DB, tidak auto-delete', () => {
    const p = join(dir, 'fake.db');
    writeFileSync(p, Buffer.from('NOT SQLITE AT ALL, PADDED TO 32 BYTES!!'));
    assert.throws(
      () => preflightCheck(p),
      (e) => e.code === 'REFUSE_START_DB' && e.reason === 'bad_header',
    );
    assert.ok(existsSync(p), 'file tidak boleh dihapus otomatis');
  });

  test('openDatabase meneruskan refuse-start (header salah)', () => {
    const p = join(dir, 'fake2.db');
    writeFileSync(p, 'garbage-not-sqlite-header');
    assert.throws(
      () => openDatabase(p, { schemaName: 'platform' }),
      (e) => e.code === 'REFUSE_START_DB',
    );
  });

  test('WAL yatim: salin -wal + hapus -shm → buka ulang tetap sukses', () => {
    const p = join(dir, 'locks.db');
    // 1) buka, tulis data (masih di -wal, belum di-checkpoint);
    //    snapshot kondisi pre-close SAAT koneksi terbuka, lalu close
    //    (auto-checkpoint + -wal dihapus), lalu restore snapshot
    //    → kondisi disk persis proses crash: -wal yatim tanpa writer.
    {
      const h = openDatabase(p, { schemaName: 'locks' });
      h.migrate();
      h.tx(() => {
        h.db
          .prepare(
            'INSERT INTO lock_registry (name, holder, acquired_at) VALUES (?,?,?)',
          )
          .run('backup', 'runner-1', '2026-01-01T00:00:00Z');
      });
      copyFileSync(p, p + '.saved');
      copyFileSync(p + '-wal', p + '-wal.saved');
      copyFileSync(p + '-shm', p + '-shm.saved');
      h.db.close();
      // restore kondisi pre-close (crash state: -wal yatim)
      copyFileSync(p + '.saved', p);
      copyFileSync(p + '-wal.saved', p + '-wal');
      copyFileSync(p + '-shm.saved', p + '-shm');
      unlinkSync(p + '.saved');
      unlinkSync(p + '-wal.saved');
      unlinkSync(p + '-shm.saved');
    }
    // 2) buka ulang: preflight memulihkan WAL yatim, data committed tetap ada
    const h2 = openDatabase(p, { schemaName: 'locks' });
    try {
      assert.equal(h2.preflight.walOrphanRecovered, true);
      assert.ok(h2.preflight.backupsMade.length >= 1, 'salinan .tmp dibuat');
      h2.migrate();
      const row = h2.db
        .prepare("SELECT holder FROM lock_registry WHERE name='backup'")
        .get();
      assert.ok(row, 'data committed dari WAL tetap terbaca setelah recovery');
      assert.equal(row.holder, 'runner-1');
      assert.equal(h2.integrityCheck().ok, true);
    } finally {
      h2.close();
    }
  });

  test('DB baru (file tidak ada) → preflight ok, walOrphanRecovered false', () => {
    const r = preflightCheck(join(dir, 'nonexistent.db'));
    assert.equal(r.ok, true);
    assert.equal(r.walOrphanRecovered, false);
  });
});
