// tests/unit/panel-auth.test.js — unit test panel/server/auth.js (DESIGN §16).
// Cakupan: bootstrapOwner sekali (secret+codes sekali, TOTP encrypted-at-rest),
// login sukses (password+TOTP), lockout 5 gagal/15 menit, TOTP salah →
// LOGIN_FAIL_2FA, recovery code sekali pakai, session expiry (inject now),
// CSRF double-submit, logout, cleanupExpired.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { PanelAuth } from '../../panel/server/auth.js';
import { totpGenerate } from '../../lib/crypto.js';
import { VmPanelError, VALIDATION, PERMISSION_DENIED } from '../../lib/errors.js';
import { AuditManager } from '../../manager/audit_manager/index.js';

function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeAuth({ audit = false, ...extra } = {}) {
  const dataDir = makeDir('vpanel-auth-');
  const auditManager = audit ? new AuditManager({ dataDir }) : null;
  const auth = new PanelAuth({ dataDir, auditManager, ...extra });
  return {
    dataDir,
    auth,
    auditManager,
    close: () => {
      try {
        auditManager?.close?.();
      } catch {
        /* ignore */
      }
      auth.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Kode TOTP yang pasti salah (bukan kode benar, bukan tetangga window ±1). */
function definitelyWrongCode(secret) {
  const correct = totpGenerate(secret);
  return correct === '000000' ? '111111' : '000000';
}

describe('PanelAuth: bootstrapOwner', () => {
  test('sekali: secret TOTP base32 + 10 recovery codes (8 char) dikembalikan sekali', () => {
    const { auth, close } = makeAuth();
    try {
      const r = auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      assert.equal(r.username, 'admin');
      assert.match(r.totpSecretBase32, /^[A-Z2-7]{32}$/);
      assert.equal(r.recoveryCodes.length, 10);
      for (const c of r.recoveryCodes) assert.match(c, /^[0-9a-f]{8}$/);
      // unik
      assert.equal(new Set(r.recoveryCodes).size, 10);

      assert.throws(
        () => auth.bootstrapOwner({ username: 'admin', password: 'password123' }),
        (e) => e instanceof VmPanelError && e.code === VALIDATION,
      );
    } finally {
      close();
    }
  });

  test('TOTP secret tersimpan TERENKRIPSI di users.db (bukan plaintext base32)', () => {
    const { dataDir, auth, close } = makeAuth();
    try {
      const r = auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      const db = new Database(join(dataDir, 'users.db'), { readonly: true });
      const row = db.prepare("SELECT totp_secret, status, password_hash FROM users WHERE username = 'admin'").get();
      db.close();
      assert.ok(row.totp_secret);
      assert.ok(!row.totp_secret.includes(r.totpSecretBase32), 'secret tidak boleh plaintext');
      const parsed = JSON.parse(row.totp_secret);
      assert.ok(parsed.iv && parsed.tag && parsed.ct, 'envelope AES-GCM');
      assert.equal(row.status, 'active');
      assert.ok(row.password_hash.includes('"hash"'), 'password_hash scrypt JSON');
    } finally {
      close();
    }
  });

  test('password < 8 char / username kosong → VALIDATION', () => {
    const { auth, close } = makeAuth();
    try {
      assert.throws(() => auth.bootstrapOwner({ username: 'admin', password: 'short' }), VmPanelError);
      assert.throws(() => auth.bootstrapOwner({ username: '', password: 'password123' }), VmPanelError);
    } finally {
      close();
    }
  });
});

describe('PanelAuth: login', () => {
  test('sukses password+TOTP → session cookie HttpOnly + csrf token', () => {
    const { auth, close } = makeAuth();
    try {
      const boot = auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      const code = totpGenerate(boot.totpSecretBase32);
      const res = auth.login({ username: 'admin', password: 'password123', totpCode: code });
      assert.equal(res.ok, true);
      assert.match(
        res.sessionCookie,
        /^vpanel_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/,
      );
      assert.ok(res.csrfCookie.startsWith('vpanel_csrf='));
      assert.ok(!res.csrfCookie.includes('HttpOnly'), 'csrf cookie bukan HttpOnly');
      const sess = auth.getSession(res.sessionId);
      assert.ok(sess);
      assert.equal(sess.user.username, 'admin');
      assert.equal(sess.user.role, 'owner');
      assert.equal(sess.csrfToken, res.csrfToken);
    } finally {
      close();
    }
  });

  test('password salah 5x → locked (login benar pun ditolak)', () => {
    const { auth, close } = makeAuth();
    try {
      const boot = auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      for (let i = 0; i < 5; i++) {
        const r = auth.login({ username: 'admin', password: `wrong-${i}` });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'invalid');
      }
      const locked = auth.login({
        username: 'admin',
        password: 'password123',
        totpCode: totpGenerate(boot.totpSecretBase32),
      });
      assert.equal(locked.ok, false);
      assert.equal(locked.reason, 'locked');
    } finally {
      close();
    }
  });

  test('TOTP salah → reason invalid_2fa + audit LOGIN_FAIL_2FA (kode tak pernah di audit)', () => {
    const { auth, auditManager, close } = makeAuth({ audit: true });
    try {
      const boot = auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      const res = auth.login({
        username: 'admin',
        password: 'password123',
        totpCode: definitelyWrongCode(boot.totpSecretBase32),
      });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'invalid_2fa');
      const list = auditManager.list({ operation: 'LOGIN_FAIL_2FA' });
      assert.equal(list.total, 1);
      const serialized = JSON.stringify(list.rows);
      assert.ok(!serialized.includes('totpCode'));
      assert.ok(!serialized.includes(boot.totpSecretBase32));
    } finally {
      close();
    }
  });

  test('recovery code: sukses sekali pakai; reuse gagal; kode lain masih jalan', () => {
    const { auth, auditManager, close } = makeAuth({ audit: true });
    try {
      const boot = auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      const [first, second] = boot.recoveryCodes;

      const r1 = auth.login({ username: 'admin', password: 'password123', recoveryCode: first });
      assert.equal(r1.ok, true);

      const r2 = auth.login({ username: 'admin', password: 'password123', recoveryCode: first });
      assert.equal(r2.ok, false);
      assert.equal(r2.reason, 'invalid_2fa');

      const r3 = auth.login({ username: 'admin', password: 'password123', recoveryCode: second });
      assert.equal(r3.ok, true);

      assert.equal(auditManager.list({ operation: 'LOGIN_SUCCESS' }).total, 2);
      assert.equal(auditManager.list({ operation: 'LOGIN_FAIL_2FA' }).total, 1);
    } finally {
      close();
    }
  });

  test('user tidak ada / password kosong → invalid (tanpa reveal)', () => {
    const { auth, close } = makeAuth();
    try {
      assert.equal(auth.login({ username: 'ghost', password: 'whatever1' }).reason, 'invalid');
      assert.equal(auth.login({ username: 'admin', password: '' }).reason, 'invalid');
      assert.equal(auth.login({}).reason, 'invalid');
    } finally {
      close();
    }
  });
});

describe('PanelAuth: session', () => {
  test('expiry: inject now — session kedaluwarsa → null', () => {
    let nowMs = 1_700_000_000_000;
    const { auth, close } = makeAuth({ now: () => nowMs, sessionTtlMs: 60_000 });
    try {
      auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      const codes = auth.issueRecoveryCodes('admin');
      const ok = auth.login({ username: 'admin', password: 'password123', recoveryCode: codes[0] });
      assert.equal(ok.ok, true);
      assert.equal(ok.sessionCookie.includes('Max-Age=60'), true);
      assert.equal(auth.getSession(ok.sessionId).user.username, 'admin');
      nowMs += 61_000;
      assert.equal(auth.getSession(ok.sessionId), null);
    } finally {
      close();
    }
  });

  test('logout menghapus session + audit LOGOUT', () => {
    const { auth, auditManager, close } = makeAuth({ audit: true });
    try {
      const boot = auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      const res = auth.login({
        username: 'admin',
        password: 'password123',
        totpCode: totpGenerate(boot.totpSecretBase32),
      });
      assert.ok(auth.getSession(res.sessionId));
      const out = auth.logout(res.sessionId, { ip: '127.0.0.1' });
      assert.equal(out.ok, true);
      assert.equal(out.existed, true);
      assert.equal(auth.getSession(res.sessionId), null);
      const again = auth.logout(res.sessionId);
      assert.equal(again.existed, false);
      assert.equal(auditManager.list({ operation: 'LOGOUT' }).total, 1);
    } finally {
      close();
    }
  });

  test('cleanupExpired menghapus session expired saja', () => {
    let nowMs = 1_700_000_000_000;
    const { auth, close } = makeAuth({ now: () => nowMs, sessionTtlMs: 60_000 });
    try {
      auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      const codes = auth.issueRecoveryCodes('admin');
      const ok = auth.login({ username: 'admin', password: 'password123', recoveryCode: codes[0] });
      assert.equal(ok.ok, true);
      nowMs += 30_000;
      const codes2 = auth.issueRecoveryCodes('admin'); // regenerate (hapus lama, 10 baru)
      const ok2 = auth.login({ username: 'admin', password: 'password123', recoveryCode: codes2[0] });
      assert.equal(ok2.ok, true);
      assert.equal(auth.getSession(ok2.sessionId) !== null, true);
      nowMs += 31_000; // session pertama expired, kedua masih hidup
      const removed = auth.cleanupExpired();
      assert.equal(removed, 1);
      assert.equal(auth.getSession(ok.sessionId), null);
      assert.ok(auth.getSession(ok2.sessionId));
    } finally {
      close();
    }
  });
});

describe('PanelAuth: CSRF double-submit', () => {
  test('validateCsrf: cocok → true; salah/kosong → false; requireCsrf → PERMISSION_DENIED', () => {
    const { auth, close } = makeAuth();
    try {
      const boot = auth.bootstrapOwner({ username: 'admin', password: 'password123' });
      const res = auth.login({
        username: 'admin',
        password: 'password123',
        totpCode: totpGenerate(boot.totpSecretBase32),
      });
      const sess = auth.getSession(res.sessionId);
      assert.equal(auth.validateCsrf(sess, res.csrfToken), true);
      assert.equal(auth.validateCsrf(sess, 'bukan-token'), false);
      assert.equal(auth.validateCsrf(sess, undefined), false);
      assert.equal(auth.validateCsrf(null, res.csrfToken), false);

      assert.throws(
        () => auth.requireCsrf(sess, undefined),
        (e) => e instanceof VmPanelError && e.code === PERMISSION_DENIED,
      );
      assert.throws(
        () => auth.requireCsrf(sess, 'salah'),
        (e) => e instanceof VmPanelError && e.code === PERMISSION_DENIED,
      );
      assert.equal(auth.requireCsrf(sess, res.csrfToken), true);
    } finally {
      close();
    }
  });
});
