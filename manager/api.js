// manager/api.js — HTTP API manager, loopback-only + bearer auth (docs/DESIGN.md §2.3).
// Node:http bawaan, JSON murni, tanpa dependency eksternal.
// Middleware order: (1) reject remote non-loopback, (2) auth bearer
// (timingSafeEqual via sha256), (3) rate limit per-token sliding window
// 60 req/menit → 429, (4) body limit 1MB → 413, (5) routing.
// Semua handler dibungkus try/catch: VmPanelError → status sesuai kode
// (PERMISSION_DENIED→403, NOT_FOUND→404, VALIDATION→400, lainnya→500),
// body {error:{code, message}} — TIDAK pernah memuat stack.

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { VmPanelError, PERMISSION_DENIED, NOT_FOUND, VALIDATION } from '../lib/errors.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const RATE_LIMIT_MAX = 60; // req per window
const RATE_WINDOW_MS = 60_000; // 1 menit

const STATUS_MAP = Object.freeze({
  [PERMISSION_DENIED]: 403,
  [NOT_FOUND]: 404,
  [VALIDATION]: 400,
  NOT_READY: 503, // modul data belum aktif (F4 data routes)
});

/**
 * Cek loopback: 127.0.0.0/8, ::1, ::ffff:127.x.x.x (IPv4-mapped).
 * Dipakai middleware (1) dan bisa diuji langsung dari unit test.
 */
export function isLoopbackAddress(addr) {
  if (typeof addr !== 'string' || addr.length === 0) return false;
  let a = addr.toLowerCase().trim();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return true;
  return false;
}

function sha256Hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

/** Bandingkan secret konstanta-waktu: hash dulu agar panjang selalu 32 byte. */
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** Sliding window in-memory per key (key = sha256 token). */
function makeRateLimiter({ max = RATE_LIMIT_MAX, windowMs = RATE_WINDOW_MS } = {}) {
  const hits = new Map(); // key -> number[] (timestamps)
  return function allow(key) {
    const now = Date.now();
    let arr = hits.get(key);
    if (!arr) {
      arr = [];
      hits.set(key, arr);
    }
    while (arr.length > 0 && arr[0] <= now - windowMs) arr.shift();
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Query param integer dengan default; invalid → VALIDATION. */
function intParam(params, name, def, min, max) {
  const raw = params.get(name);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    const range =
      min !== undefined && max !== undefined ? ` antara ${min}..${max}` : min !== undefined ? ` >= ${min}` : '';
    throw new VmPanelError(VALIDATION, `query param '${name}' harus integer${range}`, { name, value: raw });
  }
  return n;
}

/** GET /system/info — info statis manager. */
function systemInfo(manager) {
  const cfg = manager.config ?? {};
  return {
    name: 'VM-Panel',
    version: manager.version,
    dataDir: manager.dataDir,
    ports: { range: cfg.ports?.range ?? null, reserved: cfg.ports?.reserved ?? null },
  };
}

/**
 * GET /audit — proxy AuditManager.list dengan permission check audit.view.
 * Actor = 'system': userId berasal dari owner-bootstrap yang dibuat
 * PermissionManager.ensureOwnerBootstrap saat manager.start(). Bila belum ada
 * user sama sekali → fase owner-bootstrap → diizinkan.
 */
function listAudit(params, manager) {
  const am = manager.auditManager;
  const pm = manager.permissionManager;
  if (!am || !pm) {
    throw new VmPanelError(PERMISSION_DENIED, 'audit/permission manager belum siap');
  }
  const userId = manager.systemUserId;
  let decision = { allowed: true, role: null }; // owner-bootstrap: belum ada user → allowed
  if (userId) {
    decision = pm.checkPermission({ userId, action: 'audit.view' });
  }
  if (!decision.allowed) {
    throw new VmPanelError(PERMISSION_DENIED, 'audit.view ditolak', { actor: 'system' });
  }
  const opts = {
    limit: intParam(params, 'limit', 50, 1, 1000),
    offset: intParam(params, 'offset', 0, 0),
  };
  for (const k of ['actor', 'operation', 'projectId']) {
    const v = params.get(k);
    if (v !== null && v !== '') opts[k] = v;
  }
  return am.list(opts);
}

/** Baca + parse JSON body request (POST dsb.). Body kosong → null. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk?.length ?? 0;
      if (size > MAX_BODY_BYTES) {
        reject(new VmPanelError(VALIDATION, 'request body melebihi 1MB'));
        try {
          req.destroy();
        } catch {
          /* abaikan */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new VmPanelError(VALIDATION, 'request body bukan JSON valid'));
      }
    });
    req.on('error', reject);
  });
}

function makeHandler({ manager, token, allow, logger, dataRoutes }) {
  // F4: data routes terkompilasi — pattern ':param' dipisah per segmen.
  const compiledRoutes = (Array.isArray(dataRoutes) ? dataRoutes : []).map((r) => ({
    ...r,
    segs: String(r.pattern).split('/').filter(Boolean),
  }));

  /** Match method + pathname terhadap data routes (':x' = 1 segmen bebas). */
  function matchDataRoute(method, pathname) {
    if (compiledRoutes.length === 0) return null;
    const parts = pathname.split('/').filter(Boolean);
    for (const r of compiledRoutes) {
      if (r.method !== method || r.segs.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.segs.length; i++) {
        const seg = r.segs[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  /**
   * Permission check ala /audit: actor 'system' = userId owner-bootstrap.
   * Belum ada user sama sekali → fase owner-bootstrap → diizinkan.
   */
  function assertPermission(action) {
    if (!action) return;
    const userId = manager.systemUserId;
    if (!userId) return; // owner-bootstrap: diizinkan
    const pm = manager.permissionManager;
    if (!pm) throw new VmPanelError(PERMISSION_DENIED, 'permission manager belum siap');
    const decision = pm.checkPermission({ userId, action });
    if (!decision.allowed) {
      throw new VmPanelError(PERMISSION_DENIED, `${action} ditolak`, { action });
    }
  }

  async function routeRequest(route, url) {
    switch (route) {
      case 'GET /health':
        return { ok: true };
      case 'GET /system/status':
        return manager.systemStatus();
      case 'GET /system/info':
        return systemInfo(manager);
      case 'GET /projects':
        return manager.listProjects();
      case 'GET /audit':
        return listAudit(url.searchParams, manager);
      default:
        throw new VmPanelError(NOT_FOUND, `route tidak dikenal: ${route}`);
    }
  }

  return async function handle(req, res) {
    try {
      // (1) loopback only — reject sebelum apa pun
      const remote = req.socket?.remoteAddress ?? null;
      if (!isLoopbackAddress(remote)) {
        return sendJson(res, 403, {
          error: { code: PERMISSION_DENIED, message: 'hanya koneksi loopback yang diizinkan' },
        });
      }
      // (2) auth bearer
      const auth = String(req.headers?.authorization ?? '');
      const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
      if (!m || !safeEqual(m[1], token)) {
        return sendJson(res, 401, {
          error: { code: PERMISSION_DENIED, message: 'bearer token tidak valid' },
        });
      }
      // (3) rate limit per-token (sliding window, in-memory)
      if (!allow(sha256Hex(token))) {
        return sendJson(res, 429, {
          error: { code: 'RATE_LIMITED', message: `rate limit terlampaui: ${RATE_LIMIT_MAX} req/menit` },
        });
      }
      // (4) body size limit 1MB (header + guard stream)
      const cl = Number(req.headers?.['content-length'] ?? 0);
      if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
        return sendJson(res, 413, {
          error: { code: VALIDATION, message: 'request body melebihi 1MB' },
        });
      }
      if (typeof req.on === 'function') {
        let received = 0;
        req.on('data', (chunk) => {
          received += chunk?.length ?? 0;
          if (received > MAX_BODY_BYTES) {
            try {
              sendJson(res, 413, { error: { code: VALIDATION, message: 'request body melebihi 1MB' } });
            } catch {
              /* response mungkin sudah terkirim */
            }
            try {
              req.destroy();
            } catch {
              /* abaikan */
            }
          }
        });
      }
      // (5) routing — data routes F4 dulu (pattern ':param'), lalu route inti.
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = (req.method ?? 'GET').toUpperCase();
      const match = matchDataRoute(method, url.pathname);
      if (match) {
        assertPermission(match.route.permission);
        const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
        const data = await match.route.handler({
          params: match.params,
          url,
          body,
          user: 'system',
        });
        return sendJson(res, match.route.status ?? 200, data);
      }
      const result = await routeRequest(`${method} ${url.pathname}`, url);
      return sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof VmPanelError) {
        const status = STATUS_MAP[e.code] ?? 500;
        return sendJson(res, status, { error: { code: e.code, message: e.message } });
      }
      logger?.error?.('api.unhandled_error', { reason: String(e?.stack ?? e) });
      return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal server error' } });
    }
  };
}

/**
 * Buat + jalankan HTTP API server, bind 127.0.0.1 SAJA.
 * @param {{manager: object, port: number, token: string,
 *          dataRoutes?: Array<object>}} opts
 * @returns {Promise<{server: http.Server, port: number, handler: Function,
 *                     close: () => Promise<void>}>}
 */
export async function createApiServer({ manager, port, token, dataRoutes } = {}) {
  if (!manager) throw new VmPanelError(VALIDATION, 'createApiServer: manager wajib');
  if (typeof token !== 'string' || token.length === 0) {
    throw new VmPanelError(VALIDATION, 'createApiServer: token wajib');
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new VmPanelError(VALIDATION, `createApiServer: port tidak valid: ${port}`);
  }

  const logger = manager.logger ?? null;
  const allow = makeRateLimiter();
  const handler = makeHandler({ manager, token, allow, logger, dataRoutes });

  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      /* handler sudah menangani error; guard terakhir */
      try {
        sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal server error' } });
      } catch {
        /* socket mungkin sudah mati */
      }
    });
  });

  // Bind loopback SAJA (DESIGN §2.3) — tidak pernah 0.0.0.0.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(portNum, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Runtime error selanjutnya jangan crash proses — log saja.
  server.on('error', (e) => logger?.error?.('api.server_error', { reason: String(e?.message ?? e) }));

  const actualPort = server.address().port;

  /** Tutup server secara bersih (drop keep-alive idle/aktif lalu close). */
  async function close() {
    try {
      server.closeIdleConnections?.();
    } catch {
      /* abaikan */
    }
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      server.closeAllConnections?.();
    } catch {
      /* abaikan */
    }
  }

  logger?.info?.('api.listening', { port: actualPort, host: '127.0.0.1' });
  return { server, port: actualPort, handler, close };
}
