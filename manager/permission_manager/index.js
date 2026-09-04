// manager/permission_manager/index.js — PermissionManager (docs/DESIGN.md §11).
// users.db via openDatabase('users'); skema users final di lib/schema.js.
// Tabel project_scopes (§11.3) tidak ada di skema final — dibuat di sini
// idempotent (CREATE TABLE IF NOT EXISTS) karena setProjectScope/checkPermission
// membutuhkannya; tanpa menyentuh schema.js.
// Cache in-memory Map TTL 60s ({role, status, scopes}); invalidasi via
// invalidate(userId) / invalidateAll() — wajib dipanggil setelah perubahan.

import { join } from 'node:path';
import { openDatabase } from '../../lib/db.js';
import { genId } from '../../lib/ids.js';
import { VmPanelError, VALIDATION, NOT_FOUND, PERMISSION_DENIED } from '../../lib/errors.js';

const CACHE_TTL_MS = 60 * 1000; // §11.3: cache permission 60 detik

/**
 * Matriks izin §11.2. Set = role yang diizinkan per action.
 * owner: semua; operator: sesuai daftar; viewer: hanya *.view.
 * Action tak dikenal → not allowed.
 */
const ACTION_ROLES = Object.freeze({
  'project.create': new Set(['owner']),
  'project.delete': new Set(['owner']),
  'project.view': new Set(['owner', 'operator', 'viewer']),
  'project.deploy': new Set(['owner', 'operator']),
  'service.start': new Set(['owner', 'operator']),
  'service.stop': new Set(['owner', 'operator']),
  'service.restart': new Set(['owner', 'operator']),
  'service.logs.view': new Set(['owner', 'operator', 'viewer']),
  'service.health.view': new Set(['owner', 'operator', 'viewer']),
  'backup.create': new Set(['owner', 'operator']),
  'backup.restore': new Set(['owner']),
  'deployment.rollback': new Set(['owner']),
  'secret.view': new Set(['owner']),
  'permission.manage': new Set(['owner']),
  'user.manage': new Set(['owner']),
  'audit.view': new Set(['owner', 'operator']),
  'audit.purge': new Set(['owner']),
  'export.run': new Set(['owner']),
  'import.run': new Set(['owner']),
  'panel.settings': new Set(['owner']),
});

/** Action yang beroperasi pada satu project (kena scoping §11.3). */
const PROJECT_SCOPED_ACTIONS = new Set([
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
]);

const ROLES = new Set(['owner', 'operator', 'viewer']);

function nowIso() {
  return new Date().toISOString();
}

function normUsername(username) {
  if (typeof username !== 'string') return null;
  const u = username.trim();
  return u.length > 0 ? u : null;
}

export class PermissionManager {
  /** @param {{dataDir: string}} opts */
  constructor({ dataDir } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'PermissionManager: dataDir wajib');
    }
    this.#h = openDatabase(join(dataDir, 'users.db'), { schemaName: 'users' });
    this.#h.migrate();
    this.#h.db.exec(`CREATE TABLE IF NOT EXISTS project_scopes (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  PRIMARY KEY (user_id, project_id)
)`);
    this.#stmts = {
      countUsers: this.#h.db.prepare('SELECT COUNT(*) AS c FROM users'),
      insertUser: this.#h.db.prepare(
        'INSERT INTO users (id, username, role, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ),
      getUserById: this.#h.db.prepare('SELECT * FROM users WHERE id = ?'),
      getUserByUsername: this.#h.db.prepare('SELECT * FROM users WHERE username = ?'),
      setRole: this.#h.db.prepare('UPDATE users SET role = ? WHERE id = ?'),
      setStatus: this.#h.db.prepare('UPDATE users SET status = ? WHERE id = ?'),
      countActiveOwners: this.#h.db.prepare(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND status = 'active'",
      ),
      allScopes: this.#h.db.prepare('SELECT project_id, allowed FROM project_scopes WHERE user_id = ?'),
      upsertScope: this.#h.db.prepare(
        `INSERT INTO project_scopes (user_id, project_id, allowed, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, project_id) DO UPDATE SET allowed = excluded.allowed`,
      ),
      deleteScope: this.#h.db.prepare(
        'DELETE FROM project_scopes WHERE user_id = ? AND project_id = ?',
      ),
    };
  }

  #h;
  /** Map<userId, {role, status, scopes: Map<projectId, boolean>, expiresAt}> */
  #cache = new Map();
  #stmts;

  // --- internal helpers --------------------------------------------------

  #rowToUser(r) {
    if (!r) return null;
    return {
      userId: r.id,
      username: r.username,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    };
  }

  #loadUserRow(userId) {
    return this.#stmts.getUserById.get(String(userId)) ?? null;
  }

  #loadScopes(userId) {
    const scopes = new Map();
    for (const r of this.#stmts.allScopes.all(String(userId))) {
      scopes.set(r.project_id, r.allowed === 1);
    }
    return scopes;
  }

  /** Entry cache (role+status+scopes) atau null jika user tidak ada. */
  #getCached(userId) {
    const now = Date.now();
    const hit = this.#cache.get(userId);
    if (hit && hit.expiresAt > now) return hit;
    this.#cache.delete(userId);
    const row = this.#loadUserRow(userId);
    const entry = row
      ? {
          role: row.role,
          status: row.status,
          scopes: this.#loadScopes(userId),
          expiresAt: now + CACHE_TTL_MS,
        }
      : null;
    if (entry) this.#cache.set(userId, entry);
    return entry;
  }

  #requireUserRow(userId) {
    const row = this.#loadUserRow(userId);
    if (!row) {
      throw new VmPanelError(NOT_FOUND, `user tidak ditemukan: ${userId}`, { userId: String(userId) });
    }
    return row;
  }

  /** Actor wajib owner aktif untuk aksi manajemen user. */
  #requireActiveOwner(actorUserId) {
    const actor = this.#requireUserRow(actorUserId);
    if (!(actor.role === 'owner' && actor.status === 'active')) {
      throw new VmPanelError(PERMISSION_DENIED, 'hanya owner aktif yang boleh', {
        actorUserId: String(actorUserId),
      });
    }
    return actor;
  }

  // --- bootstrap & CRUD user ----------------------------------------------

  /**
   * Bootstrap owner pertama (§11.4): tabel users kosong → buat user pertama
   * role='owner', status='active'. Sudah ada user → {created:false}.
   */
  ensureOwnerBootstrap({ username } = {}) {
    const u = normUsername(username);
    if (u === null) {
      throw new VmPanelError(VALIDATION, 'ensureOwnerBootstrap: username wajib');
    }
    if (this.#stmts.countUsers.get().c > 0) {
      return { created: false };
    }
    const userId = genId('usr_');
    this.#stmts.insertUser.run(userId, u, 'owner', 'active', nowIso());
    this.#cache.set(userId, {
      role: 'owner',
      status: 'active',
      scopes: new Map(),
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { userId, created: true };
  }

  /** User by id → null jika tidak ada. TIDAK pernah memaparkan hash/TOTP. */
  getUser(userId) {
    if (userId === undefined || userId === null || userId === '') return null;
    return this.#rowToUser(this.#loadUserRow(userId));
  }

  /** User by username → null jika tidak ada. */
  getUserByUsername(username) {
    const u = normUsername(username);
    if (u === null) return null;
    return this.#rowToUser(this.#stmts.getUserByUsername.get(u) ?? null);
  }

  /**
   * Buat user: role wajib ∈ {owner,operator,viewer} else VALIDATION;
   * status default 'inactive' (owner approve via approveUser).
   */
  createUser({ username, role, status = 'inactive' } = {}) {
    const u = normUsername(username);
    if (u === null) {
      throw new VmPanelError(VALIDATION, 'createUser: username wajib');
    }
    if (!ROLES.has(role)) {
      throw new VmPanelError(VALIDATION, `createUser: role tidak valid: ${role}`, { role });
    }
    const st = status === undefined || status === null || status === '' ? 'inactive' : String(status);
    if (st !== 'active' && st !== 'inactive') {
      throw new VmPanelError(VALIDATION, `createUser: status tidak valid: ${st}`, { status: st });
    }
    if (this.#stmts.getUserByUsername.get(u)) {
      throw new VmPanelError(VALIDATION, `createUser: username sudah dipakai: ${u}`, { username: u });
    }
    const userId = genId('usr_');
    this.#stmts.insertUser.run(userId, u, role, st, nowIso());
    this.#cache.set(userId, {
      role,
      status: st,
      scopes: new Map(),
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { userId, username: u, role, status: st };
  }

  /**
   * Approve user (inactive → active). Hanya owner aktif; target tidak ada →
   * NOT_FOUND.
   */
  approveUser(userId, actorUserId) {
    const actor = this.#requireActiveOwner(actorUserId);
    const row = this.#requireUserRow(userId);
    const uid = String(userId);
    this.#h.tx(() => {
      this.#stmts.setStatus.run('active', uid);
    });
    this.#cache.delete(uid);
    return {
      userId: uid,
      username: row.username,
      status: 'active',
      approvedBy: actor.id,
    };
  }

  /**
   * Ubah role. Hanya owner aktif; role tidak valid → VALIDATION; menurunkan
   * owner aktif terakhir (sistem harus selalu punya ≥1 owner aktif) → denied.
   */
  setRole(userId, role, actorUserId) {
    if (!ROLES.has(role)) {
      throw new VmPanelError(VALIDATION, `setRole: role tidak valid: ${role}`, { role });
    }
    const actor = this.#requireActiveOwner(actorUserId);
    const row = this.#requireUserRow(userId);
    const uid = String(userId);
    const targetIsOwner = row.role === 'owner';
    const demoting = targetIsOwner && role !== 'owner';
    if (demoting) {
      const activeOwners = this.#stmts.countActiveOwners.get().c;
      const targetIsActiveOwner = row.status === 'active';
      const ownersAfter = activeOwners - (targetIsActiveOwner ? 1 : 0);
      if (ownersAfter < 1 || activeOwners < 1) {
        throw new VmPanelError(
          PERMISSION_DENIED,
          'setRole: tidak boleh menurunkan owner aktif terakhir',
          { userId: uid },
        );
      }
    }
    this.#h.tx(() => {
      this.#stmts.setRole.run(role, uid);
    });
    this.#cache.delete(uid);
    return { userId: uid, username: row.username, role, changedBy: actor.id };
  }

  /**
   * Set project scope (§11.3): allowed=true → whitelist project untuk user;
   * allowed=false → hapus dari whitelist (kembali ke akses default role).
   * Jika user punya ≥1 row scope → hanya project whitelist yang boleh.
   */
  setProjectScope(userId, projectId, allowed) {
    if (userId === undefined || userId === null || userId === '') {
      throw new VmPanelError(VALIDATION, 'setProjectScope: userId wajib');
    }
    if (projectId === undefined || projectId === null || projectId === '') {
      throw new VmPanelError(VALIDATION, 'setProjectScope: projectId wajib');
    }
    if (typeof allowed !== 'boolean') {
      throw new VmPanelError(VALIDATION, 'setProjectScope: allowed harus boolean');
    }
    this.#requireUserRow(userId);
    const uid = String(userId);
    const pid = String(projectId);
    this.#h.tx(() => {
      if (allowed) {
        this.#stmts.upsertScope.run(uid, pid, 1, nowIso());
      } else {
        this.#stmts.deleteScope.run(uid, pid);
      }
    });
    this.#cache.delete(uid);
    this.#cache.delete(uid);
    return { userId: uid, projectId: pid, allowed };
  }

  /**
   * Cek izin (§11.2 matriks + §11.3 scoping):
   *  - user tidak ada / status bukan active → not allowed
   *  - action tak dikenal atau role tidak terdaftar → not allowed
   *  - user dengan rows project_scopes: action ber-scope project hanya boleh
   *    pada project dalam whitelist (dan wajib menyertakan projectId)
   * @returns {{allowed: boolean, role: string|null}}
   */
  checkPermission({ userId, action, projectId } = {}) {
    if (userId === undefined || userId === null || userId === '') {
      return { allowed: false, role: null };
    }
    const uid = String(userId);
    const entry = this.#getCached(uid);
    const role = entry ? entry.role : null;
    if (!entry) return { allowed: false, role: null };
    if (entry.status !== 'active') return { allowed: false, role };

    const roles = ACTION_ROLES[action];
    if (!roles || !roles.has(role)) return { allowed: false, role };

    if (PROJECT_SCOPED_ACTIONS.has(action) && entry.scopes.size > 0) {
      const pid = projectId === undefined || projectId === null ? '' : String(projectId);
      if (pid === '' || entry.scopes.get(pid) !== true) {
        return { allowed: false, role };
      }
    }
    return { allowed: true, role };
  }

  /** Invalidasi cache satu user (panggil setelah perubahan role/status/scope). */
  invalidate(userId) {
    this.#cache.delete(String(userId));
  }

  /** Invalidasi seluruh cache. */
  invalidateAll() {
    this.#cache.clear();
  }

  /** Tutup koneksi DB (untuk shutdown/test). */
  close() {
    this.#h.close();
  }
}
