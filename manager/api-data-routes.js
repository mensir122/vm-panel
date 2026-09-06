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
import os from 'node:os';
import path from 'node:path';
import { VmPanelError, NOT_FOUND, VALIDATION } from '../lib/errors.js';

/** Jumlah baris tail untuk GET /logs/:serviceId (desain: 200 baris). */
const LOG_TAIL_LINES = 200;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 1000;
const MB = 1024 * 1024;

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

/**
 * Spesifikasi host + pemakaian (GET /system/specs). CPU/mem via node:os;
 * disk via fs.statfsSync(dataDir) (Node >= 18.15) — filesystem tanpa
 * dukungan statfs → disk null (tidak boleh membuat route gagal).
 * Semua nilai advisory, sampled on request.
 */
function collectSystemSpecs(dataDir) {
  const cores = Math.max(os.cpus().length, 1);
  const load1 = Math.round((os.loadavg()[0] ?? 0) * 100) / 100;
  const loadPct = Math.max(0, Math.min(100, (load1 / cores) * 100));

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);

  let disk = null;
  try {
    const st = fs.statfsSync(dataDir);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    const used = Math.max(0, total - free);
    if (Number.isFinite(total) && total > 0) {
      disk = {
        totalMb: Math.round(total / MB),
        usedMb: Math.round(used / MB),
        freeMb: Math.round(free / MB),
        usedPct: clampPct01((used / total) * 100),
      };
    }
  } catch {
    disk = null; // statfs tidak didukung fs/OS → disk tidak tersedia
  }

  return {
    cpu: {
      model: String(os.cpus()[0]?.model ?? 'unknown'),
      cores,
      load1,
      usagePct: Math.round(loadPct * 100) / 100,
    },
    memory: {
      totalMb: Math.round(totalMem / MB),
      usedMb: Math.round(usedMem / MB),
      freeMb: Math.round(freeMem / MB),
      usedPct: clampPct01((usedMem / totalMem) * 100),
    },
    disk,
    host: {
      platform: process.platform,
      osRelease: String(os.release()),
      hostname: String(os.hostname()),
      uptimeSec: Math.round(os.uptime()),
      nodeVersion: process.version,
    },
  };
}

/** Persen 0..100 dibulatkan; input tak finite → 0. */
function clampPct01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

// ── GitHub runner status (GET /system/github) ──────────────────────────────
// Dashboard menampilkan status chain Actions + specs runner tanpa membuka
// github.com/.../actions. Sumber: REST API publik (repo default mensir122/
// vm-panel, override via env GITHUB_REPO; GITHUB_TOKEN opsional → header
// Authorization). Fail-soft TOTAL: gagal apa pun → {available:false, reason,
// fetchedAt} — TIDAK PERNAH melempar (dispatcher api.js akan 500 kalau throw).

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_REPO_DEFAULT = 'mensir122/vm-panel';
const GITHUB_CACHE_MS = 60_000; // cache in-memory 60 detik
const GITHUB_TIMEOUT_MS = 5_000; // timeout fetch 5 detik (AbortController)

/** Cache in-memory status GitHub: { at: epochMs, data } atau null. */
let githubStatusCache = null;

/** GET JSON dari GitHub REST API; timeout 5s; token opsional; 404 → err.status=404. */
async function ghGetJson(pathname, { raw = false } = {}) {
  const headers = {
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'User-Agent': 'vm-panel',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const tok = process.env.GITHUB_TOKEN;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GITHUB_TIMEOUT_MS);
  try {
    const r = await fetch(`${GITHUB_API_BASE}${pathname}`, { headers, signal: ctrl.signal });
    if (!r.ok) {
      const err = new Error(`GitHub API ${pathname} → HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Workflow run API → shape panel {runId, status, conclusion, createdAt, url}. */
function mapGhRun(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    runId: r.id ?? null,
    status: typeof r.status === 'string' ? r.status : null,
    conclusion: r.conclusion ?? null,
    createdAt: r.created_at ?? null,
    url: r.html_url ?? null,
  };
}

/**
 * Kumpulkan status GitHub runner: runs vm.yml (5 terbaru) → activeRun
 * (status != completed terbaru) + lastRun (conclusion != null terbaru);
 * specs dari contents/runner-specs.json?ref=state (404 → null).
 * Gagal apa pun → {available:false, reason, fetchedAt} — tidak pernah throw.
 */
async function collectGithubRunnerStatus() {
  const repo = process.env.GITHUB_REPO || GITHUB_REPO_DEFAULT;
  try {
    const runsData = await ghGetJson(`/repos/${repo}/actions/workflows/vm.yml/runs?per_page=5`);
    const runs = Array.isArray(runsData?.workflow_runs) ? runsData.workflow_runs : [];
    // API mengembalikan runs terbaru-dulu → find() = yang terbaru.
    const activeRaw = runs.find((r) => r?.status !== 'completed') ?? null;
    const lastRaw = runs.find((r) => r?.conclusion != null) ?? null;
    let specs = null;
    try {
      specs = await ghGetJson(`/repos/${repo}/contents/runner-specs.json?ref=state`, { raw: true });
    } catch (e) {
      if (e?.status === 404) {
        specs = null; // branch 'state' / file belum ada (chain pertama)
      } else {
        throw e;
      }
    }
    return {
      available: true,
      activeRun: activeRaw ? mapGhRun(activeRaw) : null,
      lastRun: lastRaw ? mapGhRun(lastRaw) : null,
      specs: specs && typeof specs === 'object' && !Array.isArray(specs) ? specs : null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      available: false,
      reason: String(e?.message ?? e ?? 'unknown error'),
      fetchedAt: new Date().toISOString(),
    };
  }
}

/** Status GitHub runner dengan cache in-memory 60 detik. */
async function getGithubRunnerStatus() {
  if (githubStatusCache && Date.now() - githubStatusCache.at < GITHUB_CACHE_MS) {
    return githubStatusCache.data;
  }
  const data = await collectGithubRunnerStatus();
  githubStatusCache = { at: Date.now(), data };
  return data;
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

    // ── system specs ────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/system/specs',
      // Tanpa permission tambahan — bagian system, dibaca oleh panel dashboard.
      handler: () => collectSystemSpecs(manager.dataDir),
    },

    // ── system: GitHub runner (chain Actions + specs, tanpa buka Actions UI) ─
    {
      method: 'GET',
      pattern: '/system/github',
      // Tanpa permission tambahan — bagian system, dibaca oleh panel dashboard.
      // Handler fail-soft: gagal apa pun → 200 {available:false, reason}.
      handler: () => getGithubRunnerStatus(),
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
