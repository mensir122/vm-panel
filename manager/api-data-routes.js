// manager/api-data-routes.js — data routes F4 Wave 1 untuk Manager API
// (docs/DESIGN.md §2.3). registerDataRoutes({manager}) → daftar route
// {method, pattern, handler, permission?, status?} yang dipasang ke
// createApiServer (manager/api.js — param opsional `dataRoutes`).
//
// Pattern mendukung placeholder ':name' (SATU segmen path), dipasang oleh
// dispatcher di api.js. Dispatcher bertanggung jawab atas:
//   (1) permission check (route.permission) via permissionManager +
//       systemUserId — pola sama dengan GET /audit (owner-bootstrap fase →
//       diizinkan);
//   (2) pemanggilan handler({params, url, body, user});
//   (3) try/catch VmPanelError → status map SAMA dengan api.js
//       (PERMISSION_DENIED→403, NOT_FOUND→404, VALIDATION→400, lainnya→500)
//       ditambah NOT_READY→503. Error non-VmPanelError → 500 INTERNAL.
//
// Data tidak tersedia (modul manager masih null / belum aktif) →
// VmPanelError 'NOT_READY' → 503 {error:{code:'NOT_READY',
// message:'modul belum aktif'}}.

import fs from 'node:fs';
import path from 'node:path';
import { VmPanelError, NOT_FOUND, VALIDATION } from '../lib/errors.js';

/** Jumlah baris tail untuk GET /logs/:serviceId (desain: 200 baris). */
const LOG_TAIL_LINES = 200;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 1000;

/** Modul manager belum aktif → 503 NOT_READY (dipetakan dispatcher api.js). */
function notReady() {
  return new VmPanelError('NOT_READY', 'modul belum aktif');
}

/** Ambil modul manager; null/undefined → NOT_READY. */
function requireMod(mod) {
  if (!mod) throw notReady();
  return mod;
}

/** Query param integer dengan default; invalid → VALIDATION. */
function intQuery(url, name, def, min = 1, max = LIST_LIMIT_MAX) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new VmPanelError(
      VALIDATION,
      `query param '${name}' harus integer ${min}..${max}`,
      { name, value: raw },
    );
  }
  return n;
}

/** body.serviceId wajib string non-kosong; else VALIDATION. */
function serviceIdFromBody(body) {
  const id = body?.serviceId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new VmPanelError(VALIDATION, "body 'serviceId' wajib string tidak kosong");
  }
  return id;
}

/** serviceId aman untuk path file log (anti traversal): karakter terbatas. */
function assertSafeId(id, label) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new VmPanelError(VALIDATION, `${label} tidak valid`, { [label]: id ?? null });
  }
  return id;
}

/** Tail file: N baris terakhir. File tidak ada → NOT_FOUND. */
function tailLines(filePath, maxLines) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new VmPanelError(
        NOT_FOUND,
        `file log tidak ditemukan: ${path.basename(filePath)}`,
        { path: filePath },
      );
    }
    throw e;
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  return { lines: lines.slice(Math.max(0, total - maxLines)), total };
}

/**
 * Daftar data routes F4 Wave 1. Handler menerima ctx
 * {params, url, body, user} dan melempar VmPanelError untuk kondisi error;
 * hasil return dikirim dispatcher sebagai JSON (status default 200, atau
 * route.status untuk create → 201).
 *
 * @param {{manager: object}} opts manager instance (modul dibaca lazily per
 *   request sehingga route aman dipasang sebelum modul siap → 503 NOT_READY).
 * @returns {Array<{method: string, pattern: string, handler: Function,
 *   permission?: string, status?: number}>}
 */
export function registerDataRoutes({ manager } = {}) {
  if (!manager) {
    throw new VmPanelError(VALIDATION, 'registerDataRoutes: manager wajib');
  }

  /** Aksi service lifecycle + audit actor (dipanggil via POST /services/:id/<action>). */
  const serviceAction = (action) => ({
    method: 'POST',
    pattern: `/services/:id/${action}`,
    permission: 'service.start',
    handler: async ({ params, user }) => {
      const sm = requireMod(manager.serviceManager);
      let result;
      if (action === 'start') result = await sm.startService(params.id);
      else if (action === 'stop') result = await sm.stopService(params.id);
      else result = await sm.restartService(params.id);
      // Audit actor eksplisit (ServiceManager._audit tidak membawa actor).
      try {
        manager.auditManager?.append?.({
          actor: user ?? 'system',
          operation: `service.${action}`,
          input: { serviceId: params.id },
          result: 'ok',
        });
      } catch {
        /* audit gagal tidak boleh menggagalkan aksi */
      }
      return result;
    },
  });

  return [
    // ── services ────────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/services',
      permission: 'service.health.view',
      handler: () => {
        const sm = requireMod(manager.serviceManager);
        return { rows: sm.listServices() };
      },
    },
    {
      method: 'GET',
      pattern: '/services/:id',
      handler: ({ params }) => requireMod(manager.serviceManager).getService(params.id),
    },
    {
      method: 'GET',
      pattern: '/services/:id/health',
      handler: async ({ params }) => {
        const sm = requireMod(manager.serviceManager);
        return sm.healthService(params.id, manager.healthManager);
      },
    },
    serviceAction('start'),
    serviceAction('stop'),
    serviceAction('restart'),

    // ── deployments ─────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/deployments',
      handler: ({ url }) => {
        const dm = requireMod(manager.deploymentManager);
        const opts = { limit: intQuery(url, 'limit', LIST_LIMIT_DEFAULT) };
        const projectId = url.searchParams.get('projectId');
        const status = url.searchParams.get('status');
        if (projectId) opts.projectId = projectId;
        if (status) opts.status = status;
        return { rows: dm.listDeployments(opts) };
      },
    },
    {
      method: 'GET',
      pattern: '/deployments/:id',
      handler: ({ params }) => requireMod(manager.deploymentManager).getDeployment(params.id),
    },

    // ── health state ────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/health-state',
      handler: ({ url }) => {
        const hm = requireMod(manager.healthManager);
        const serviceId = url.searchParams.get('serviceId');
        if (!serviceId) {
          throw new VmPanelError(VALIDATION, "query param 'serviceId' wajib");
        }
        const state = hm.getStatus(serviceId);
        let checks = [];
        try {
          checks = hm.listChecks({ serviceId, limit: intQuery(url, 'limit', 50) });
        } catch {
          checks = []; // listChecks gagal tidak boleh merusak read state
        }
        return { serviceId, status: state, checks };
      },
    },

    // ── backups ─────────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/backups',
      handler: ({ url }) => {
        const bm = requireMod(manager.backupManager);
        return { rows: bm.listBackups({ limit: intQuery(url, 'limit', LIST_LIMIT_DEFAULT) }) };
      },
    },
    {
      method: 'POST',
      pattern: '/backups',
      permission: 'backup.create',
      status: 201,
      handler: async () => {
        const bm = requireMod(manager.backupManager);
        const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
        return { backupId: res.backupId, path: res.path, verification: res.verification };
      },
    },

    // ── recovery / supervisor ───────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/recovery/status',
      handler: () => {
        const sm = requireMod(manager.serviceManager);
        const rows = sm.listServices().map((svc) => {
          let sup = null;
          try {
            sup = sm.getSupervisorState(svc.id);
          } catch {
            sup = null;
          }
          return {
            serviceId: svc.id,
            name: svc.name,
            projectId: svc.projectId,
            status: svc.status,
            supervisor: {
              state: sup?.state ?? null,
              crashLoop: sup?.crashLoop === true,
              restartCount: sup?.restartCount ?? 0,
              backoffUntil: sup?.backoffUntil ?? null,
            },
          };
        });
        return { rows };
      },
    },
    {
      method: 'POST',
      pattern: '/recovery/retry',
      permission: 'service.start',
      handler: async ({ body }) => {
        const serviceId = serviceIdFromBody(body);
        const sup = manager.internalSupervisor;
        if (!sup || typeof sup.manualRetry !== 'function') {
          throw new VmPanelError(VALIDATION, 'supervisor belum aktif');
        }
        await sup.manualRetry(serviceId);
        return { serviceId, retried: true };
      },
    },

    // ── ports ───────────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/ports',
      handler: () => {
        const sm = requireMod(manager.serviceManager);
        const rows = sm.store.db.prepare('SELECT * FROM ports ORDER BY port').all();
        return { rows };
      },
    },

    // ── projects ────────────────────────────────────────────────────────────
    {
      method: 'POST',
      pattern: '/projects',
      permission: 'project.create',
      status: 201,
      handler: ({ body }) => {
        const pm = requireMod(manager.projectManager);
        const input = {};
        if (body?.name !== undefined) input.name = body.name;
        if (body?.type !== undefined) input.type = body.type;
        if (body?.port !== undefined && body?.port !== null && body?.port !== '') {
          input.port = Number(body.port);
        }
        return pm.createProject(input);
      },
    },
    {
      method: 'POST',
      pattern: '/projects/:id/deploy',
      permission: 'project.deploy',
      handler: async ({ params, user }) => {
        const dm = requireMod(manager.deploymentManager);
        // Sinkron: tunggu pipeline selesai (sukses/gagal) → hasil dikirim.
        return dm.deploy({
          projectId: params.id,
          source: { type: 'workspace' },
          actor: user ?? 'system',
        });
      },
    },

    // ── logs ────────────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/logs/:serviceId',
      permission: 'service.logs.view',
      handler: ({ params }) => {
        const serviceId = assertSafeId(params.serviceId, 'serviceId');
        const file = path.join(manager.rootDir, 'logs', 'projects', `${serviceId}.log`);
        const { lines, total } = tailLines(file, LOG_TAIL_LINES);
        return { serviceId, lines, total, truncated: total > lines.length };
      },
    },
  ];
}

export default registerDataRoutes;
