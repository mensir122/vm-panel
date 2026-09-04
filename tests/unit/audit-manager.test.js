// tests/unit/audit-manager.test.js — AuditManager: append/list roundtrip,
// normalisasi field + redaksi, filter, purge two-phase (node:test).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditManager } from '../../manager/audit_manager/index.js';
import { VmPanelError, PERMISSION_DENIED, VALIDATION } from '../../lib/errors.js';

const tmpRoot = join(tmpdir(), 'vmpanel-audit-mgr-test');
mkdirSync(tmpRoot, { recursive: true });

/** ISO timestamp yang dijamin > prevIso (resolusi ms bisa sama). */
function nextIsoAfter(prevIso) {
  let s = new Date().toISOString();
  while (s <= prevIso) s = new Date().toISOString();
  return s;
}

let dir;
let mgr;

beforeEach(() => {
  dir = mkdtempSync(join(tmpRoot, 'run-'));
  mgr = new AuditManager({ dataDir: dir });
});

afterEach(() => {
  mgr.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('AuditManager.append + list — roundtrip & normalisasi', () => {
  test('append → list: field tersimpan & kembali dengan benar', () => {
    const before = new Date().toISOString();
    const { id, at } = mgr.append({
      actor: 'owner-alice',
      userId: 'usr_A1B2C3D4E5F',
      role: 'owner',
      projectId: 'prj_A1B2C3D4E5F',
      serviceId: 'svc_A1B2C3D4E5F',
      operation: 'service.start',
      input: { name: 'api' },
      statusBefore: 'stopped',
      statusAfter: 'running',
      revisionBefore: 'rev1',
      revisionAfter: 'rev2',
      pidOld: '100',
      pidNew: '200',
      port: 3000,
      backupId: 'bak_A1B2C3D4E5F',
      deploymentId: 'dep_A1B2C3D4E5F',
      runnerId: 'run-1',
      recoveryAction: 'none',
      result: 'ok',
      ip: '127.0.0.1',
    });
    assert.ok(Number.isInteger(id) && id > 0);
    assert.ok(at >= before, 'timestamp UTC ISO otomatis');
    assert.match(at, /Z$/);

    const { rows, total } = mgr.list({ limit: 10 });
    assert.equal(total, 1);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.id, id);
    assert.equal(row.at, at);
    assert.equal(row.actor, 'owner-alice');
    assert.equal(row.userId, 'usr_A1B2C3D4E5F');
    assert.equal(row.role, 'owner');
    assert.equal(row.projectId, 'prj_A1B2C3D4E5F');
    assert.equal(row.operation, 'service.start');
    assert.equal(row.statusBefore, 'stopped');
    assert.equal(row.statusAfter, 'running');
    assert.equal(row.port, 3000);
    assert.equal(row.deploymentId, 'dep_A1B2C3D4E5F');
    assert.equal(row.result, 'ok');
    // ip (§14.2) disimpan di dalam input_json (skema final tak punya kolom ip)
    assert.deepEqual(row.input, { name: 'api', ip: '127.0.0.1' });
  });

  test('field kosong/undefined → null; timestamp Z', () => {
    const { at } = mgr.append({ operation: 'system.startup' });
    const [row] = mgr.list({ limit: 1 }).rows;
    assert.match(at, /Z$/);
    assert.equal(row.actor, null);
    assert.equal(row.userId, null);
    assert.equal(row.projectId, null);
    assert.equal(row.statusBefore, null);
    assert.equal(row.error, null);
    assert.deepEqual(row.input, {});
  });

  test('redaksi input: token/password di input & error tersamarkan', () => {
    mgr.append({
      operation: 'secret.set',
      input: { token: 'dummy-token-abc', note: 'plain' },
      error: 'login failed: password: hunter2',
    });
    const [row] = mgr.list({ operation: 'secret.set' }).rows;
    assert.equal(row.input.token, '***REDACTED***');
    assert.equal(row.input.note, 'plain');
    assert.equal(row.error, 'login failed: password: ***REDACTED***');
    assert.ok(!JSON.stringify(row).includes('hunter2'), 'nilai sensitif tidak bocor');
  });

  test('input > 8KB dipotong agar tetap ≤ 8KB', () => {
    mgr.append({ operation: 'big', input: { blob: 'x'.repeat(20000) } });
    const [row] = mgr.list({ limit: 1 }).rows;
    const stored = JSON.stringify(row.input);
    assert.ok(Buffer.byteLength(stored, 'utf8') <= 8192);
  });

  test('append tanpa operation → VALIDATION', () => {
    assert.throws(
      () => mgr.append({ actor: 'x' }),
      (e) => {
        assert.ok(e instanceof VmPanelError);
        assert.equal(e.code, VALIDATION);
        return true;
      },
    );
  });
});

describe('AuditManager.list — filter', () => {
  beforeEach(() => {
    mgr.append({ actor: 'alice', operation: 'service.start', projectId: 'prj_P1' });
    mgr.append({ actor: 'bob', operation: 'service.stop', projectId: 'prj_P1' });
    mgr.append({ actor: 'alice', operation: 'project.create', projectId: 'prj_P2' });
  });

  test('filter actor', () => {
    const { rows, total } = mgr.list({ actor: 'alice' });
    assert.equal(total, 2);
    assert.ok(rows.every((r) => r.actor === 'alice'));
  });

  test('filter operation', () => {
    const { rows, total } = mgr.list({ operation: 'service.start' });
    assert.equal(total, 1);
    assert.equal(rows[0].operation, 'service.start');
  });

  test('filter projectId', () => {
    const { total } = mgr.list({ projectId: 'prj_P2' });
    assert.equal(total, 1);
  });

  test('kombinasi actor + projectId', () => {
    assert.equal(mgr.list({ actor: 'bob', projectId: 'prj_P1' }).total, 1);
    assert.equal(mgr.list({ actor: 'bob', projectId: 'prj_P2' }).total, 0);
  });

  test('from/to rentang waktu + pagination (total tidak terpengaruh limit)', () => {
    assert.equal(mgr.list({ from: '2999-01-01T00:00:00Z' }).total, 0);
    assert.equal(mgr.list({ to: '1999-01-01T00:00:00Z' }).total, 0);
    const page = mgr.list({ limit: 2, offset: 0 });
    assert.equal(page.total, 3);
    assert.equal(page.rows.length, 2);
    assert.ok(page.rows[0].id > page.rows[1].id, 'urutan terbaru dulu');
    const page2 = mgr.list({ limit: 2, offset: 2 });
    assert.equal(page2.rows.length, 1);
  });
});

describe('AuditManager.purge — two-phase', () => {
  test('execute tanpa token → PERMISSION_DENIED', () => {
    mgr.append({ actor: 'a', operation: 'x' });
    const req = mgr.purgeRequest({
      reason: 'cleanup',
      actor: 'owner',
      beforeIso: nextIsoAfter(mgr.list({ limit: 1 }).rows[0].at),
    });
    assert.throws(
      () => mgr.purgeExecute({ requestId: req.requestId }),
      (e) => {
        assert.ok(e instanceof VmPanelError);
        assert.equal(e.code, PERMISSION_DENIED);
        return true;
      },
    );
  });

  test('token salah → PERMISSION_DENIED; request masih valid untuk token benar', () => {
    mgr.append({ actor: 'a', operation: 'x' });
    const req = mgr.purgeRequest({
      reason: 'cleanup',
      actor: 'owner',
      beforeIso: nextIsoAfter(mgr.list({ limit: 1 }).rows[0].at),
    });
    assert.throws(
      () =>
        mgr.purgeExecute({ requestId: req.requestId, confirmToken: 'dummy-token-abc', actor: 'owner' }),
      (e) => e.code === PERMISSION_DENIED,
    );
    const r = mgr.purgeExecute({
      requestId: req.requestId,
      confirmToken: req.confirmToken,
      actor: 'owner',
    });
    assert.equal(r.deleted, 1);
  });

  test('requestId tidak dikenal → PERMISSION_DENIED', () => {
    assert.throws(
      () => mgr.purgeExecute({ requestId: 'pur_XXXXXXXXXX', confirmToken: 'dummy-token-abc' }),
      (e) => e.code === PERMISSION_DENIED,
    );
  });

  test('purgeRequest validasi: reason kosong / beforeIso jelek → VALIDATION', () => {
    assert.throws(
      () => mgr.purgeRequest({ reason: '  ', actor: 'o', beforeIso: new Date().toISOString() }),
      (e) => e.code === VALIDATION,
    );
    assert.throws(
      () => mgr.purgeRequest({ reason: 'r', actor: 'o', beforeIso: 'not-a-date' }),
      (e) => e.code === VALIDATION,
    );
  });

  test('flow lengkap request→execute: rows hilang + event AUDIT_PURGE ada, tanpa isi row lama', () => {
    for (let i = 0; i < 5; i++) {
      mgr.append({
        actor: 'old-user',
        operation: 'legacy',
        projectId: 'prj_OLD',
        input: { secret: 'old-secret-value' },
      });
    }
    assert.equal(mgr.list({ limit: 100 }).total, 5);
    const lastOldAt = mgr.list({ limit: 1 }).rows[0].at;
    const beforeIso = nextIsoAfter(lastOldAt); // semua 5 row < beforeIso
    mgr.append({ actor: 'keeper', operation: 'recent' });
    assert.equal(mgr.list({ limit: 100 }).total, 6);

    const req = mgr.purgeRequest({ reason: 'GDPR erasure', actor: 'owner-alice', beforeIso });
    assert.match(req.requestId, /^pur_/);
    assert.equal(typeof req.confirmToken, 'string');
    assert.ok(req.confirmToken.length >= 32, 'token acak memadai');
    assert.equal(req.summary, 5);
    assert.ok(Date.parse(req.expiresAt) > Date.now(), 'expiresAt 10 menit di depan');

    const { deleted } = mgr.purgeExecute({
      requestId: req.requestId,
      confirmToken: req.confirmToken,
      actor: 'owner-alice',
    });
    assert.equal(deleted, 5);

    const all = mgr.list({ limit: 100 });
    assert.equal(all.total, 2, 'keeper + event AUDIT_PURGE');
    const keeper = all.rows.find((r) => r.operation === 'recent');
    assert.ok(keeper, 'row di luar range selamat');
    assert.equal(keeper.actor, 'keeper');

    const purgeRows = all.rows.filter((r) => r.operation === 'AUDIT_PURGE');
    assert.equal(purgeRows.length, 1, 'event AUDIT_PURGE tercatat');
    const ev = purgeRows[0];
    assert.equal(ev.statusAfter, 'purged');
    assert.equal(ev.result, 'ok');
    assert.equal(ev.input.reason, 'GDPR erasure');
    assert.equal(ev.input.deleted, 5);
    assert.equal(ev.input.summary, 5);
    assert.ok(ev.input.beforeIso === beforeIso);
    const blob = JSON.stringify(ev);
    assert.ok(!blob.includes('old-secret-value'), 'isi row lama tidak bocor ke event purge');
    assert.ok(!blob.includes('old-user'));
  });

  test('token expired → ditolak PERMISSION_DENIED', () => {
    const shortDir = join(dir, 'short');
    mkdirSync(shortDir, { recursive: true });
    const short = new AuditManager({ dataDir: shortDir, purgeTtlMs: 1 });
    try {
      short.append({ actor: 'a', operation: 'x' });
      const req = short.purgeRequest({
        reason: 'r',
        actor: 'o',
        beforeIso: nextIsoAfter(short.list({ limit: 1 }).rows[0].at),
      });
      const until = Date.now() + 30; // pastikan TTL 1ms sudah lewat
      while (Date.now() < until) {}
      assert.ok(Date.parse(req.expiresAt) <= Date.now(), 'expiresAt sudah lewat');
      assert.throws(
        () =>
          short.purgeExecute({ requestId: req.requestId, confirmToken: req.confirmToken, actor: 'o' }),
        (e) => e.code === PERMISSION_DENIED,
      );
    } finally {
      short.close();
    }
  });

  test('token sekali-pakai: execute kedua kali → PERMISSION_DENIED', () => {
    mgr.append({ actor: 'a', operation: 'x' });
    const req = mgr.purgeRequest({
      reason: 'r',
      actor: 'o',
      beforeIso: nextIsoAfter(mgr.list({ limit: 1 }).rows[0].at),
    });
    mgr.purgeExecute({ requestId: req.requestId, confirmToken: req.confirmToken, actor: 'o' });
    assert.throws(
      () => mgr.purgeExecute({ requestId: req.requestId, confirmToken: req.confirmToken, actor: 'o' }),
      (e) => e.code === PERMISSION_DENIED,
    );
  });
});
