// manager/project_manager/index.js — ProjectManager (docs/DESIGN.md §4, §6).
// projects.db via lib/db.js openDatabase({schemaName:'projects'}). DDL dari
// lib/schema.js — tidak ditulis duplikat. Semua error VmPanelError berkode kanonik.

import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../lib/db.js';
import { genId, isValidId } from '../../lib/ids.js';
import {
  VmPanelError,
  VALIDATION,
  NOT_FOUND,
  PERMISSION_DENIED,
  PORT_ILLEGAL,
} from '../../lib/errors.js';
import { assertInside } from '../../lib/paths.js';
import { ADAPTERS } from '../adapters/index.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Subset transisi status legal (DESIGN.md §4/§6). */
const LEGAL_TRANSITIONS = Object.freeze({
  created: new Set(['stopped', 'failed']),
  stopped: new Set(['archived', 'removed']),
  failed: new Set(['stopped', 'archived', 'removed']),
  archived: new Set(['stopped']), // restore
});

/** Kolom projects.db yang boleh di-update via updateProject. */
const UPDATABLE_FIELDS = ['port', 'restartPolicy', 'healthCheck', 'branch'];

function nowIso() {
  return new Date().toISOString();
}

/**
 * ProjectManager — lifecycle project: create/read/update/status/archive/remove.
 * Workspace folder per project: <workspacesRoot>/<projectId>.
 */
export class ProjectManager {
  /** @param {{dataDir: string, workspacesRoot: string, processManager?: object}} opts
   *  processManager opsional: bila ada, assertPortLegal didelegasikan ke sana. */
  constructor({ dataDir, workspacesRoot, processManager = null }) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'ProjectManager: dataDir wajib');
    }
    if (!workspacesRoot || typeof workspacesRoot !== 'string') {
      throw new VmPanelError(VALIDATION, 'ProjectManager: workspacesRoot wajib');
    }
    this.dataDir = path.resolve(dataDir);
    this.workspacesRoot = path.resolve(workspacesRoot);
    this.processManager = processManager;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.workspacesRoot, { recursive: true });
    const opened = openDatabase(path.join(this.dataDir, 'projects.db'), {
      schemaName: 'projects',
    });
    this.store = opened;
    opened.migrate();
  }

  _rowToRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      repoUrl: row.repo_url,
      branch: row.branch,
      workspacePath: row.workspace_path,
      startCmd: row.start_cmd,
      port: row.port,
      resourceLimits: row.resource_limits ? JSON.parse(row.resource_limits) : null,
      restartPolicy: row.restart_policy,
      healthCheck: row.health_url ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  /**
   * Buat project baru. Return record lengkap (termasuk id + workspacePath).
   * @param {{
   *   name: string, type: string, repoUrl?: string, branch?: string,
   *   startCmd?: string, port?: number, restartPolicy?: string,
   *   healthCheck?: object|string, resourceLimits?: object, template?: string,
   * }} input
   */
  createProject(input = {}) {
    const name = input.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new VmPanelError(VALIDATION, `name tidak valid: ${String(name)}`, {
        field: 'name',
        pattern: NAME_RE.source,
      });
    }
    const dup = this.store.db.prepare('SELECT id FROM projects WHERE name = ?').get(name);
    if (dup) {
      throw new VmPanelError(VALIDATION, `name sudah dipakai: ${name}`, {
        field: 'name',
        value: name,
      });
    }
    const type = input.type;
    const knownTypes = Object.keys(ADAPTERS);
    if (type !== 'custom' && !knownTypes.includes(type)) {
      throw new VmPanelError(VALIDATION, `type tidak dikenal: ${String(type)}`, {
        field: 'type',
        known: [...knownTypes, 'custom'],
      });
    }
    let port = null;
    if (input.port != null) {
      this._assertPort(input.port);
      port = input.port;
    }

    const id = genId('prj_');
    const workspacePath = path.join(this.workspacesRoot, id);
    fs.mkdirSync(workspacePath, { recursive: true });

    const now = nowIso();
    const restartPolicy = input.restartPolicy ?? 'on-failure';
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO projects
            (id, name, type, status, repo_url, branch, workspace_path, start_cmd,
             port, resource_limits, restart_policy, health_url, created_at, updated_at)
           VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          type,
          input.repoUrl ?? null,
          input.branch ?? 'main',
          workspacePath,
          input.startCmd ?? null,
          port,
          input.resourceLimits ? JSON.stringify(input.resourceLimits) : null,
          restartPolicy,
          input.healthCheck ? JSON.stringify(input.healthCheck) : null,
          now,
          now,
        );
    });
    return this.getProject(id);
  }

  /**
   * Validasi port legal (semantik sama dengan ProcessManager.assertPortLegal:
   * integer 10000-65535). Bila processManager diinject, delegasikan.
   */
  _assertPort(port) {
    if (this.processManager && typeof this.processManager.assertPortLegal === 'function') {
      return this.processManager.assertPortLegal(port);
    }
    const ok = Number.isInteger(port) && port >= 10000 && port <= 65535;
    if (!ok) {
      throw new VmPanelError(PORT_ILLEGAL, `port tidak legal: ${String(port)}`, {
        port,
        min: 10000,
        max: 65535,
      });
    }
    return port;
  }

  getProject(id) {
    if (!isValidId(id, 'prj_')) {
      throw new VmPanelError(VALIDATION, `format project id tidak valid: ${String(id)}`, { id });
    }
    const row = this.store.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!row) {
      throw new VmPanelError(NOT_FOUND, `project tidak ditemukan: ${id}`, { id });
    }
    return this._rowToRecord(row);
  }

  listProjects({ status } = {}) {
    if (status != null) {
      const rows = this.store.db
        .prepare('SELECT * FROM projects WHERE status = ? ORDER BY created_at')
        .all(String(status));
      return rows.map((r) => this._rowToRecord(r));
    }
    const rows = this.store.db.prepare('SELECT * FROM projects ORDER BY created_at').all();
    return rows.map((r) => this._rowToRecord(r));
  }

  /**
   * Update field aman saja. Return {before, after} sebagai audit diff.
   * @param {string} id
   * @param {{port?: number, restartPolicy?: string, healthCheck?: object|string, branch?: string}} patch
   */
  updateProject(id, patch = {}) {
    const before = this.getProject(id);
    const sets = {};
    for (const field of UPDATABLE_FIELDS) {
      if (!(field in patch)) continue;
      let value = patch[field];
      if (field === 'port' && value != null) {
        this._assertPort(value);
      }
      if (field === 'healthCheck' && value != null && typeof value === 'object') {
        value = JSON.stringify(value);
      }
      sets[field] = value ?? null;
    }
    if (Object.keys(sets).length === 0) {
      throw new VmPanelError(VALIDATION, 'updateProject: tidak ada field yang bisa di-update', {
        allowed: UPDATABLE_FIELDS,
      });
    }

    const colMap = {
      port: 'port',
      restartPolicy: 'restart_policy',
      healthCheck: 'health_url',
      branch: 'branch',
    };
    const assignments = Object.keys(sets)
      .map((f) => `${colMap[f]} = ?`)
      .join(', ');
    const values = Object.values(sets);
    this.store.db
      .prepare(`UPDATE projects SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...values, nowIso(), id);
    const after = this.getProject(id);
    return { before, after };
  }

  /**
   * Ubah status project. Transisi legal: subset LEGAL_TRANSITIONS.
   */
  setStatus(id, status) {
    const rec = this.getProject(id);
    const allowed = LEGAL_TRANSITIONS[rec.status];
    if (!allowed || !allowed.has(status)) {
      throw new VmPanelError(
        VALIDATION,
        `transisi status ilegal: ${rec.status} -> ${String(status)}`,
        { from: rec.status, to: status, allowed: allowed ? [...allowed] : [] },
      );
    }
    this.store.db
      .prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
    return this.getProject(id);
  }

  archiveProject(id) {
    const rec = this.getProject(id);
    if (rec.status !== 'stopped') {
      throw new VmPanelError(
        VALIDATION,
        `archive butuh status stopped (status sekarang: ${rec.status})`,
        { id, status: rec.status },
      );
    }
    this.store.db
      .prepare(
        `UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), nowIso(), id);
    return this.getProject(id);
  }

  restoreProject(id) {
    const rec = this.getProject(id);
    if (rec.status !== 'archived') {
      throw new VmPanelError(
        VALIDATION,
        `restore butuh status archived (status sekarang: ${rec.status})`,
        { id, status: rec.status },
      );
    }
    // archived -> stopped (transisi legal 'restore')
    return this.setStatus(id, 'stopped');
  }

  /**
   * Two-phase remove. Fase 1 (token issuance) di luar modul ini: pemanggil
   * membuat confirmToken; fase 2: removeProject(id, {confirmToken, expectedToken})
   * — mismatch → PERMISSION_DENIED. TIDAK menyentuh backup apa pun; hanya
   * menghapus row projects.db + workspace folder (yang dijamin di dalam
   * workspacesRoot via assertInside).
   */
  removeProject(id, { confirmToken, expectedToken } = {}) {
    const rec = this.getProject(id);
    if (confirmToken !== expectedToken || typeof confirmToken !== 'string' || !confirmToken) {
      throw new VmPanelError(PERMISSION_DENIED, 'confirmToken tidak cocok', { id });
    }
    // Proteksi path: workspace wajib di dalam workspacesRoot.
    assertInside(this.workspacesRoot, rec.workspacePath);

    this.store.tx(() => {
      this.store.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });

    if (fs.existsSync(rec.workspacePath)) {
      fs.rmSync(rec.workspacePath, { recursive: true, force: true });
    }
    return { removed: true, id };
  }

  close() {
    this.store.close();
  }
}

export default ProjectManager;
