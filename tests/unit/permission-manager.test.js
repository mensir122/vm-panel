// tests/unit/permission-manager.test.js — PermissionManager: bootstrap owner,
// matriks izin §11.2 × 3 role, scoping §11.3, guard owner terakhir,
// approve flow, cache invalidasi, validasi role (node:test).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager } from '../../manager/permission_manager/index.js';
import { openDatabase } from '../../lib/db.js';
import { VmPanelError, VALIDATION, NOT_FOUND, PERMISSION_DENIED } from '../../lib/errors.js';

const tmpRoot = join(tmpdir(), 'vmpanel-perm-mgr-test');
mkdirSync(tmpRoot, { recursive: true });

let dir;
let pm;

/** Setup standar: owner aktif + satu user per role (operator/viewer aktif,
 *  satu user inactive untuk flow approve). */
function setupUsers() {
  const owner = pm.ensureOwnerBootstrap({ username: 'root' });
  const operator = pm.createUser({ username: 'op1', role: 'operator', status: 'active' });
  const viewer = pm.createUser({ username: 'view1', role: 'viewer', status: 'active' });
  const inactive = pm.createUser({ username: 'pend1', role: 'operator' });
  return { owner, operator, viewer, inactive };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpRoot, 'run-'));
  pm = new PermissionManager({ dataDir: dir });
});

afterEach(() => {
  pm.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureOwnerBootstrap', () => {
  test('users kosong → owner pertama dibuat active, created:true', () => {
    const r = pm.ensureOwnerBootstrap({ username: 'root' });
    assert.equal(r.created, true);
    assert.match(r.userId, /^usr_/);
    const u = pm.getUser(r.userId);
    assert.equal(u.role, 'owner');
    assert.equal(u.status, 'active');
    assert.equal(u.username, 'root');
  });

  test('sudah ada user → created:false, tidak menimpa apa pun', () => {
    pm.ensureOwnerBootstrap({ username: 'root' });
    const r = pm.ensureOwnerBootstrap({ username: 'someone-else' });
    assert.equal(r.created, false);
    assert.equal(r.userId, undefined);
    assert.equal(pm.getUserByUsername('someone-else'), null);
    assert.equal(pm.getUserByUsername('root').username, 'root');
  });

  test('username kosong → VALIDATION', () => {
    assert.throws(() => pm.ensureOwnerBootstrap({ username: '' }), (e) => e.code === VALIDATION);
    assert.throws(() => pm.ensureOwnerBootstrap({}), (e) => e.code === VALIDATION);
  });
});

describe('getUser / getUserByUsername', () => {
  test('ditemukan & null untuk yang tidak ada', () => {
    const { operator } = setupUsers();
    assert.equal(pm.getUserByUsername('op1').userId, operator.userId);
    assert.equal(pm.getUser(operator.userId).username, 'op1');
    assert.equal(pm.getUser('usr_NOEXIST123'), null);
    assert.equal(pm.getUserByUsername('nobody'), null);
    assert.equal(pm.getUser(''), null);
  });

  test('profil tidak memaparkan password_hash/totp_secret', () => {
    pm.ensureOwnerBootstrap({ username: 'root' });
    const u = pm.getUserByUsername('root');
    assert.ok(!('passwordHash' in u) && !('totpSecret' in u));
  });
});

describe('createUser — validasi', () => {
  test('role invalid → VALIDATION', () => {
    assert.throws(
      () => pm.createUser({ username: 'x', role: 'superadmin' }),
      (e) => {
        assert.ok(e instanceof VmPanelError);
        assert.equal(e.code, VALIDATION);
        return true;
      },
    );
    assert.throws(() => pm.createUser({ username: 'x' }), (e) => e.code === VALIDATION);
  });

  test('status default inactive; username duplikat → VALIDATION', () => {
    pm.ensureOwnerBootstrap({ username: 'root' });
    const u = pm.createUser({ username: 'new1', role: 'viewer' });
    assert.equal(u.status, 'inactive');
    assert.throws(
      () => pm.createUser({ username: 'new1', role: 'viewer' }),
      (e) => e.code === VALIDATION,
    );
  });
});

describe('matriks izin §11.2 — semua action × 3 role', () => {
  const ALL_ACTIONS = [
    'project.create',
    'project.delete',
    'project.view',
    'project.deploy',
    'service.start',
    'service.stop',
    'service.restart',
    'service.logs.view',
    'service.health.view',
    'backup.create',
    'backup.restore',
    'deployment.rollback',
    'secret.view',
    'permission.manage',
    'user.manage',
    'audit.view',
    'audit.purge',
    'export.run',
    'import.run',
    'panel.settings',
  ];
  const OWNER_ONLY = [
    'project.create',
    'project.delete',
    'backup.restore',
    'deployment.rollback',
    'secret.view',
    'permission.manage',
    'user.manage',
    'audit.purge',
    'export.run',
    'import.run',
    'panel.settings',
  ];
  const OPERATOR_ALLOWED = [
    'project.view',
    'project.deploy',
    'service.start',
    'service.stop',
    'service.restart',
    'service.logs.view',
    'service.health.view',
    'backup.create',
    'audit.view',
  ];
  const VIEWER_ALLOWED = [
    'project.view',
    'service.logs.view',
    'service.health.view',
  ];

  test('owner: semua action allowed', () => {
    const { owner } = setupUsers();
    for (const a of ALL_ACTIONS) {
      const r = pm.checkPermission({ userId: owner.userId, action: a });
      assert.equal(r.allowed, true, `owner harus boleh ${a}`);
      assert.equal(r.role, 'owner');
    }
  });

  test('operator: hanya sesuai daftar §11.2', () => {
    const { operator } = setupUsers();
    for (const a of ALL_ACTIONS) {
      const r = pm.checkPermission({ userId: operator.userId, action: a });
      const expected = OPERATOR_ALLOWED.includes(a);
      assert.equal(r.allowed, expected, `operator ${a} = ${expected}`);
      assert.equal(r.role, 'operator');
    }
  });

  test('viewer: hanya *.view', () => {
    const { viewer } = setupUsers();
    for (const a of ALL_ACTIONS) {
      const r = pm.checkPermission({ userId: viewer.userId, action: a });
      const expected = VIEWER_ALLOWED.includes(a);
      assert.equal(r.allowed, expected, `viewer ${a} = ${expected}`);
      assert.equal(r.role, 'viewer');
    }
  });

  test('action tak dikenal → not allowed (semua role)', () => {
    const { owner, operator, viewer } = setupUsers();
    for (const u of [owner, operator, viewer]) {
      const r = pm.checkPermission({ userId: u.userId, action: 'nonexistent.action' });
      assert.equal(r.allowed, false);
    }
  });

  test('user tidak ada / userId kosong → not allowed', () => {
    assert.equal(pm.checkPermission({ userId: 'usr_NOEXIST123', action: 'project.view' }).allowed, false);
    assert.equal(pm.checkPermission({ action: 'project.view' }).allowed, false);
  });

  test('user inactive → not allowed meski role sesuai', () => {
    const { inactive } = setupUsers();
    const r = pm.checkPermission({ userId: inactive.userId, action: 'project.view' });
    assert.equal(r.allowed, false);
    assert.equal(r.role, 'operator');
  });
});

describe('scoping project §11.3', () => {
  test('viewer dengan scope hanya melihat project itu', () => {
    const { viewer } = setupUsers();
    // tanpa scope rows → semua project sesuai role
    assert.equal(
      pm.checkPermission({ userId: viewer.userId, action: 'project.view', projectId: 'prj_A1B2C3D4E5F' }).allowed,
      true,
    );
    // set scope hanya prj_ALPHA
    pm.setProjectScope(viewer.userId, 'prj_ALPHA', true);
    pm.invalidate(viewer.userId);
    assert.equal(
      pm.checkPermission({ userId: viewer.userId, action: 'project.view', projectId: 'prj_ALPHA' }).allowed,
      true,
    );
    assert.equal(
      pm.checkPermission({ userId: viewer.userId, action: 'project.view', projectId: 'prj_BETA' }).allowed,
      false,
    );
    // action ber-scope project tanpa projectId → ditolak saat ada scope rows
    assert.equal(pm.checkPermission({ userId: viewer.userId, action: 'project.view' }).allowed, false);
    // scope dihapus (allowed=false) → kembali default role
    pm.setProjectScope(viewer.userId, 'prj_ALPHA', false);
    pm.invalidate(viewer.userId);
    assert.equal(
      pm.checkPermission({ userId: viewer.userId, action: 'project.view', projectId: 'prj_ALPHA' }).allowed,
      true,
    );
  });

  test('scope membatasi operator untuk deploy', () => {
    const { operator } = setupUsers();
    pm.setProjectScope(operator.userId, 'prj_OK', true);
    pm.invalidate(operator.userId);
    assert.equal(
      pm.checkPermission({ userId: operator.userId, action: 'project.deploy', projectId: 'prj_OK' }).allowed,
      true,
    );
    assert.equal(
      pm.checkPermission({ userId: operator.userId, action: 'project.deploy', projectId: 'prj_OTHER' }).allowed,
      false,
    );
    // action yang tidak ber-scope project (audit.view tanpa projectId)
    // tidak terpengaruh scope rows
    assert.equal(
      pm.checkPermission({ userId: operator.userId, action: 'audit.view' }).allowed,
      true,
    );
  });

  test('setProjectScope validasi: allowed bukan boolean / user tidak ada', () => {
    const { owner } = setupUsers();
    assert.throws(
      () => pm.setProjectScope(owner.userId, 'prj_X', 'yes'),
      (e) => e.code === VALIDATION,
    );
    assert.throws(
      () => pm.setProjectScope('usr_NOEXIST123', 'prj_X', true),
      (e) => e.code === NOT_FOUND,
    );
  });
});

describe('setRole — owner-only & guard owner terakhir', () => {
  test('bukan owner → PERMISSION_DENIED', () => {
    const { operator, viewer } = setupUsers();
    assert.throws(
      () => pm.setRole(viewer.userId, 'operator', operator.userId),
      (e) => e.code === PERMISSION_DENIED,
    );
  });

  test('role invalid → VALIDATION', () => {
    const { owner, viewer } = setupUsers();
    assert.throws(
      () => pm.setRole(viewer.userId, 'superadmin', owner.userId),
      (e) => e.code === VALIDATION,
    );
  });

  test('owner menaikkan viewer → operator; effect langsung setelah invalidate', () => {
    const { owner, viewer } = setupUsers();
    const r = pm.setRole(viewer.userId, 'operator', owner.userId);
    assert.equal(r.role, 'operator');
    pm.invalidate(viewer.userId);
    assert.equal(pm.getUser(viewer.userId).role, 'operator');
  });

  test('tidak boleh menurunkan owner aktif terakhir', () => {
    const { owner } = setupUsers();
    // hanya ada 1 owner aktif (root) — menurunkannya harus ditolak
    assert.throws(
      () => pm.setRole(owner.userId, 'operator', owner.userId),
      (e) => {
        assert.equal(e.code, PERMISSION_DENIED);
        return true;
      },
    );
    // buat owner kedua aktif → sekarang menurunkan salah satu boleh
    const owner2 = pm.createUser({ username: 'root2', role: 'owner', status: 'active' });
    pm.setRole(owner2.userId, 'operator', owner.userId); // masih 1 owner (root)
    // coba lagi menurunkan owner terakhir → ditolak
    assert.throws(
      () => pm.setRole(owner.userId, 'viewer', owner.userId),
      (e) => e.code === PERMISSION_DENIED,
    );
    // setelah root diturunkan tidak mungkin — verifikasi root masih owner
    assert.equal(pm.getUser(owner.userId).role, 'owner');
  });

  test('setRole ke user yang tidak ada → NOT_FOUND', () => {
    const { owner } = setupUsers();
    assert.throws(
      () => pm.setRole('usr_NOEXIST123', 'viewer', owner.userId),
      (e) => e.code === NOT_FOUND,
    );
  });
});

describe('approveUser — flow inactive → active', () => {
  test('owner approve user inactive', () => {
    const { owner, inactive } = setupUsers();
    const r = pm.approveUser(inactive.userId, owner.userId);
    assert.equal(r.status, 'active');
    assert.equal(pm.getUser(inactive.userId).status, 'active');
  });

  test('non-owner tidak bisa approve → PERMISSION_DENIED', () => {
    const { operator, inactive } = setupUsers();
    assert.throws(
      () => pm.approveUser(inactive.userId, operator.userId),
      (e) => e.code === PERMISSION_DENIED,
    );
    assert.equal(pm.getUser(inactive.userId).status, 'inactive');
  });

  test('approve user yang tidak ada → NOT_FOUND', () => {
    const { owner } = setupUsers();
    assert.throws(
      () => pm.approveUser('usr_NOEXIST123', owner.userId),
      (e) => e.code === NOT_FOUND,
    );
  });
});

describe('cache 60s + invalidasi', () => {
  test('ubah role → invalidate → checkPermission mencerminkan role baru', () => {
    const { viewer } = setupUsers();
    assert.equal(pm.checkPermission({ userId: viewer.userId, action: 'project.deploy' }).allowed, false);
    // ubah role DI LUAR API manager (DB langsung) — cache masih memegang viewer
    const h = openDatabase(join(dir, 'users.db'), { schemaName: 'users' });
    try {
      h.db.prepare("UPDATE users SET role = 'operator' WHERE id = ?").run(viewer.userId);
    } finally {
      h.close();
    }
    // tanpa invalidate: cache stale → masih denied
    assert.equal(pm.checkPermission({ userId: viewer.userId, action: 'project.deploy' }).allowed, false);
    pm.invalidate(viewer.userId);
    assert.equal(pm.checkPermission({ userId: viewer.userId, action: 'project.deploy' }).allowed, true);
  });

  test('setRole internal sudah menghapus cache (perubahan terlihat tanpa invalidate manual)', () => {
    const { owner, viewer } = setupUsers();
    pm.setRole(viewer.userId, 'operator', owner.userId);
    // cache dihapus oleh setRole; cek permission langsung berubah
    assert.equal(pm.checkPermission({ userId: viewer.userId, action: 'service.start' }).allowed, true);
  });

  test('invalidateAll menghapus semua entry cache', () => {
    const { owner, viewer } = setupUsers();
    // hangatkan cache
    pm.checkPermission({ userId: viewer.userId, action: 'project.view' });
    assert.equal(pm.checkPermission({ userId: viewer.userId, action: 'project.deploy' }).allowed, false);
    // ubah role DI LUAR API manager (DB langsung) — cache masih memegang role lama
    const h = openDatabase(join(dir, 'users.db'), { schemaName: 'users' });
    try {
      h.db.prepare("UPDATE users SET role = 'operator' WHERE id = ?").run(viewer.userId);
    } finally {
      h.close();
    }
    // tanpa invalidasi → cache stale masih viewer
    assert.equal(pm.checkPermission({ userId: viewer.userId, action: 'project.deploy' }).allowed, false);
    pm.invalidateAll();
    assert.equal(pm.checkPermission({ userId: viewer.userId, action: 'project.deploy' }).allowed, true);
  });

  test('status berubah via approveUser → cache ikut terhapus', () => {
    const { owner, inactive } = setupUsers();
    assert.equal(pm.checkPermission({ userId: inactive.userId, action: 'project.view' }).allowed, false);
    pm.approveUser(inactive.userId, owner.userId);
    assert.equal(pm.checkPermission({ userId: inactive.userId, action: 'project.view' }).allowed, true);
  });

  test('setProjectScope + invalidate: perubahan scope terlihat', () => {
    const { viewer } = setupUsers();
    pm.checkPermission({ userId: viewer.userId, action: 'project.view', projectId: 'prj_A1B2C3D4E5F' });
    pm.setProjectScope(viewer.userId, 'prj_ONLY', true);
    pm.invalidate(viewer.userId);
    assert.equal(
      pm.checkPermission({ userId: viewer.userId, action: 'project.view', projectId: 'prj_A1B2C3D4E5F' }).allowed,
      false,
    );
    assert.equal(
      pm.checkPermission({ userId: viewer.userId, action: 'project.view', projectId: 'prj_ONLY' }).allowed,
      true,
    );
  });
});
