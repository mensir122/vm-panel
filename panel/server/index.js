// panel/server/index.js — PanelServer: server web panel (docs/DESIGN.md §2.2,
// §16, §17). node:http bind 127.0.0.1; SSR via render.js + panel/templates/
// (untuk test: templatesDir/staticDir override). Data halaman via ManagerClient
// (inject-able); manager mati → banner "Manager tidak terjangkau" + empty state
// (tidak crash). F4 Wave 2: halaman menarik data dari Manager API (/system/status,
// /projects, /services, /deployments, /health-state, /recovery/status, /backups,
// /audit, /logs/:serviceId) + aksi POST (/projects, /projects/:id/deploy,
// /services/:id/start|stop|restart|retry, /backups). Render mengikuti kontrak
// VARS blok komentar templates (nav, user, banner, flash + fragmen raw per
// halaman) memakai kelas CSS panel/static/panel.css (table, badge, dot, card,
// grid, empty, bar, kv, log). First-run: GET/POST /bootstrap — token sekali-pakai
// in-memory (TTL 15 menit) → owner aktif; TOTP secret + recovery codes tampil
// SEKALI di respons (tidak pernah ke log/audit).
// Keamanan: rate limit global per-IP + login/bootstrap per-IP, session cookie
// HttpOnly SameSite=Strict, CSRF double-submit untuk semua POST, permission
// gating via PermissionManager, body limit 1MB, traversal proteksi static
// (/assets/ dan /static/), stack TIDAK pernah bocor ke response.

import http from 'node:http';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { renderTemplate, escapeHtml } from './render.js';
import { PanelAuth, SESSION_COOKIE, CSRF_COOKIE } from './auth.js';
import { ManagerClient } from '../../lib/api-client.js';
import { VmPanelError, VALIDATION, NOT_FOUND, PERMISSION_DENIED } from '../../lib/errors.js';

const BODY_LIMIT_BYTES = 1024 * 1024; // 1MB
const RATE_WINDOW_MS = 60_000;
const DEFAULT_PORT = 8080;
const DEFAULT_RATE_PER_MIN = 60;
const DEFAULT_LOGIN_RATE_PER_MIN = 10;
const DEFAULT_SESSION_TTL_MIN = 480;
const DEFAULT_MANAGER_API_PORT = 8097;
const MANAGER_DOWN_BANNER = 'Manager tidak terjangkau';
const ENDPOINT_TODO_NOTE = 'endpoint belum tersedia (F5)';
const BOOTSTRAP_TTL_MS = 15 * 60 * 1000;
const FAVICON_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230a0a0a'/%3E%3Cpath d='M9 9l7 14 7-14' fill='none' stroke='%2358a6ff' stroke-width='2.5'/%3E%3C/svg%3E";

const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const STATUS_BY_CODE = {
  [VALIDATION]: 400,
  [NOT_FOUND]: 404,
  [PERMISSION_DENIED]: 403,
  RATE_LIMITED: 429,
  BODY_TOO_LARGE: 413,
};

/** Halaman terproteksi → action PermissionManager (matriks §11.2). */
const PAGE_ACTIONS = {
  '/': 'project.view',
  '/dashboard': 'project.view',
  '/projects': 'project.view',
  '/services': 'project.view',
  '/deployments': 'project.view',
  '/health': 'service.health.view',
  '/recovery': 'project.view',
  '/backups': 'project.view',
  '/audit': 'audit.view',
  '/users': 'user.manage',
  '/settings': 'panel.settings',
  '/logs': 'service.logs.view',
};

// --- fragmen HTML (kelas CSS persis panel/static/panel.css) ------------------

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', match: ['/', '/dashboard'] },
  { href: '/projects', label: 'Projects', match: ['/projects'] },
  { href: '/services', label: 'Services', match: ['/services'] },
  { href: '/deployments', label: 'Deployments', match: ['/deployments'] },
  { href: '/health', label: 'Health', match: ['/health'] },
  { href: '/recovery', label: 'Recovery', match: ['/recovery'] },
  { href: '/backups', label: 'Backups', match: ['/backups'] },
  { href: '/logs', label: 'Logs', match: ['/logs'] },
  { href: '/audit', label: 'Audit', match: ['/audit'] },
  { href: '/users', label: 'Users', match: ['/users'] },
  { href: '/settings', label: 'Settings', match: ['/settings'] },
];

function navHtml(pathname) {
  const items = NAV_ITEMS.map((it) => {
    const active = it.match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
    return `<li><a href="${it.href}"${active ? ' class="nav__link--active" aria-current="page"' : ''}>${it.label}</a></li>`;
  }).join('');
  return `<nav class="nav" aria-label="Primary"><ul>${items}</ul></nav>`;
}

function alertFrag(kind, text) {
  return `<div class="alert alert--${kind}" role="alert">${escapeHtml(text)}</div>`;
}

function emptyState({ title = 'Belum ada data.', hint = '' } = {}) {
  return `<div class="empty"><p class="empty__title">${escapeHtml(title)}</p>${hint ? `<p class="empty__hint">${escapeHtml(hint)}</p>` : ''}</div>`;
}

/**
 * Tabel generik: div.table-wrap > table.table (kelas desainer).
 * columns: [{label, cls?, cell(row) → raw HTML untuk isi td}]; rows kosong →
 * fragmen empty state {empty:{title,hint}}.
 */
function buildTable(columns, rows, { empty } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return emptyState(typeof empty === 'string' ? { title: empty } : empty ?? {});
  }
  const head = columns.map((c) => `<th scope="col">${escapeHtml(c.label ?? '')}</th>`).join('');
  const body = rows
    .map(
      (r) =>
        `<tr>${columns
          .map((c) => `<td${c.cls ? ` class="${escapeHtml(c.cls)}"` : ''}>${c.cell(r) ?? ''}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function csrfInput(token) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(String(token ?? ''))}">`;
}

/** Form aksi POST (button opsional data-confirm / data-confirm-phrase). */
function actionForm(action, { label, cls = 'btn btn--sm', confirm = '', phrase = '', csrf = '', hidden = {} } = {}) {
  const hiddenHtml = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('');
  const confirmAttr = confirm ? ` data-confirm="${escapeHtml(confirm)}"` : '';
  const phraseAttr = phrase ? ` data-confirm-phrase="${escapeHtml(phrase)}"` : '';
  return `<form method="post" action="${escapeHtml(action)}">${hiddenHtml}${csrfInput(csrf)}<button class="${cls}" type="submit"${confirmAttr}${phraseAttr}>${escapeHtml(label)}</button></form>`;
}

/** Mapping dot: healthy→ok, unhealthy/failed/crash_loop→fail, degraded→warn, stopped/disabled→off, unknown→unknown. */
function dotClass(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'disabled') return 'dot--disabled';
  if (s === 'crash_loop') return 'dot--crash_loop';
  if (['healthy', 'ok', 'running', 'active', 'success', 'pass', 'valid', 'enabled'].includes(s)) return 'dot--healthy';
  if (['degraded', 'warn', 'warning', 'pending', 'starting', 'recovering', 'deploying'].includes(s)) return 'dot--degraded';
  if (['unhealthy', 'failed', 'fail', 'error', 'err', 'corrupt', 'locked'].includes(s)) return 'dot--unhealthy';
  if (['stopped', 'created', 'inactive', 'exited', 'canceled'].includes(s)) return 'dot--stopped';
  return 'dot--unknown';
}

function userDotClass(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'active') return 'dot--healthy';
  if (s === 'pending') return 'dot--degraded';
  if (s === 'locked') return 'dot--unhealthy';
  if (s === 'disabled') return 'dot--disabled';
  return 'dot--unknown';
}

function statusCell(status, dotClsOverride) {
  const s = String(status ?? 'unknown');
  const dot = dotClsOverride ?? dotClass(s);
  return `<span class="status"><span class="dot ${dot}" role="img" aria-label="status: ${escapeHtml(s.toLowerCase())}"></span>${escapeHtml(s)}</span>`;
}

function badgeHtml(text, variant = '') {
  const cls = variant ? `badge badge--${variant}` : 'badge';
  return `<span class="${cls}">${escapeHtml(String(text ?? ''))}</span>`;
}

function deployBadgeVariant(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'success') return 'ok';
  if (s === 'failed') return 'err';
  if (s === 'rolled_back') return 'warn';
  return '';
}

function resultBadgeVariant(result) {
  const s = String(result ?? '').toLowerCase();
  if (s === 'pass' || s === 'ok') return 'ok';
  if (s === 'warn') return 'warn';
  if (s === 'fail' || s === 'error') return 'err';
  return '';
}

function verifyBadgeVariant(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'valid') return 'ok';
  if (s === 'pending') return '';
  if (['failed', 'corrupt', 'expired', 'error'].includes(s)) return 'err';
  return '';
}

function auditBadgeVariant(result) {
  const s = String(result ?? '').toLowerCase();
  if (s === 'ok') return 'ok';
  if (s === 'fail') return 'err';
  if (s === 'warn') return 'warn';
  return '';
}

/** Timestamp → "YYYY-MM-DD HH:MM:SS UTC" (ISO UTC); tak parseable → apa adanya. */
function fmtTime(v) {
  if (v === null || v === undefined || v === '') return '—';
  const ms = Date.parse(String(v));
  if (!Number.isFinite(ms)) return escapeHtml(String(v));
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function fmtDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '—';
  const d = Math.floor(s / 86400);
  const p = (n) => String(n).padStart(2, '0');
  return `${d}d ${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(Math.floor(s % 60))}`;
}

function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function barHtml(label, pct) {
  const variant = pct >= 90 ? ' bar__fill--crit' : pct >= 70 ? ' bar__fill--warn' : '';
  return `<div class="bar"><div class="bar__head"><span class="bar__label">${escapeHtml(label)}</span><span class="bar__value mono">${pct}%</span></div><div class="bar__track"><div class="bar__fill${variant}" style="width:${pct}%"></div></div></div>`;
}

function serviceActions(svc, csrf) {
  const id = String(svc.id ?? '');
  const name = String(svc.name ?? id);
  const status = String(svc.status ?? 'unknown');
  const enc = encodeURIComponent(id);
  const forms = [];
  if (status === 'stopped') {
    forms.push(actionForm(`/services/${enc}/start`, { label: 'Start', cls: 'btn btn--sm btn--primary', csrf }));
  } else {
    forms.push(actionForm(`/services/${enc}/stop`, { label: 'Stop', cls: 'btn btn--sm', confirm: `Stop service ${name}?`, csrf }));
  }
  forms.push(
    actionForm(`/services/${enc}/restart`, { label: 'Restart', cls: 'btn btn--sm', confirm: `Restart service ${name}?`, csrf }),
  );
  return `<div class="table__actions">${forms.join('')}</div>`;
}

export class PanelServer {
  /**
   * @param {{rootDir?: string, config?: object, dataDir: string,
   *          managerClient?: object, templatesDir?: string, staticDir?: string,
   *          auditManager?: object}} opts
   * config: object ala loadConfig (panel.port, panel.ratePerMin, ...,
   * manager.apiPort, manager.tokenFile). managerClient inject-able (test mock).
   */
  constructor({ rootDir, config, dataDir, managerClient, templatesDir, staticDir, auditManager } = {}) {
    const cfg = config && typeof config === 'object' ? config : {};
    const panelCfg = cfg.panel && typeof cfg.panel === 'object' ? cfg.panel : {};

    if (!dataDir || typeof dataDir !== 'string') {
      throw new VmPanelError(VALIDATION, 'PanelServer: dataDir wajib');
    }

    this.#port = Number.isInteger(panelCfg.port) ? panelCfg.port : DEFAULT_PORT;
    this.#ratePerMin = Number.isInteger(panelCfg.ratePerMin) ? panelCfg.ratePerMin : DEFAULT_RATE_PER_MIN;
    this.#loginRatePerMin = Number.isInteger(panelCfg.loginRatePerMin)
      ? panelCfg.loginRatePerMin
      : DEFAULT_LOGIN_RATE_PER_MIN;
    const ttlMin = Number.isInteger(panelCfg.sessionTtlMin) ? panelCfg.sessionTtlMin : DEFAULT_SESSION_TTL_MIN;

    this.#auth = new PanelAuth({ dataDir, auditManager, sessionTtlMs: ttlMin * 60_000 });
    this.#auditManager = auditManager ?? null;
    this.#managerClient = managerClient ?? null;
    this.#managerApiPort = cfg.manager?.apiPort ?? DEFAULT_MANAGER_API_PORT;
    this.#managerTokenFile = resolve(
      rootDir ?? process.cwd(),
      cfg.manager?.tokenFile ?? join('runtime', 'sockets', 'cli-token'),
    );
    this.#templatesDir = templatesDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
    this.#staticDir = staticDir
      ? resolve(staticDir)
      : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'static');
    this.#server = null;
    this.#defaultManager = null;
  }

  #port;
  #ratePerMin;
  #loginRatePerMin;
  #auth;
  #managerClient;
  #defaultManager;
  #managerApiPort;
  #managerTokenFile;
  #templatesDir;
  #staticDir;
  #server;
  #rateBuckets = new Map();
  #auditManager;
  #bootstrapTokens = new Map(); // token sekali-pakai → expiresAt (ms)

  // --- lifecycle -----------------------------------------------------------

  /** Listen di 127.0.0.1:<port> (port 0 = ephemeral, untuk test). */
  start() {
    if (this.#server) return Promise.resolve(this.address);
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        }
        try {
          res.end();
        } catch {
          /* socket sudah mati */
        }
      });
    });
    this.#server = server;
    return new Promise((resolvePromise, rejectPromise) => {
      const onError = (err) => {
        this.#server = null;
        rejectPromise(err);
      };
      server.once('error', onError);
      server.listen(this.#port, '127.0.0.1', () => {
        server.off('error', onError);
        resolvePromise(this.address);
      });
    });
  }

  /** Tutup server + koneksi DB auth. Idempotent. */
  close() {
    try {
      this.#server?.closeAllConnections?.();
    } catch {
      /* optional API */
    }
    return new Promise((resolvePromise) => {
      const finish = () => {
        try {
          this.#auth.close();
        } catch {
          /* sudah tertutup */
        }
        resolvePromise();
      };
      const server = this.#server;
      this.#server = null;
      if (!server || !server.listening) return finish();
      server.close(() => finish());
    });
  }

  get address() {
    return this.#server && this.#server.listening ? this.#server.address() : null;
  }

  get port() {
    const a = this.address;
    return a ? a.port : this.#port;
  }

  /** Akses PanelAuth internal (bootstrap owner, dsb). */
  get auth() {
    return this.#auth;
  }

  // --- util HTTP -------------------------------------------------------------

  #sendHtml(res, status, html, extraHeaders = {}) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
    res.end(html);
  }

  #sendJson(res, status, payload) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  #redirect(res, location, extraHeaders = {}) {
    if (res.headersSent) return;
    res.writeHead(302, { Location: location, ...extraHeaders });
    res.end();
  }

  #isHttps(req) {
    if (req.socket?.encrypted === true) return true;
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    return proto === 'https';
  }

  #parseCookies(req) {
    const out = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of String(header).split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k !== '') out[k] = v;
    }
    return out;
  }

  #readBody(req) {
    return new Promise((resolvePromise, rejectPromise) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
        req.resume();
        rejectPromise(new VmPanelError('BODY_TOO_LARGE', 'body terlalu besar (limit 1MB)'));
        return;
      }
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > BODY_LIMIT_BYTES) {
          rejectPromise(new VmPanelError('BODY_TOO_LARGE', 'body terlalu besar (limit 1MB)'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
      req.on('error', rejectPromise);
    });
  }

  async #readParsedBody(req) {
    const raw = await this.#readBody(req);
    if (raw === '') return {};
    return Object.fromEntries(new URLSearchParams(raw));
  }

  #isRateLimited(key, limit) {
    const now = Date.now();
    const arr = (this.#rateBuckets.get(key) ?? []).filter((t) => t > now - RATE_WINDOW_MS);
    arr.push(now);
    this.#rateBuckets.set(key, arr);
    if (this.#rateBuckets.size > 10_000) {
      for (const [k, v] of this.#rateBuckets) {
        if (v.every((t) => t <= now - RATE_WINDOW_MS)) this.#rateBuckets.delete(k);
      }
    }
    return arr.length > limit;
  }

  // --- render ----------------------------------------------------------------

  #render(templateName, vars) {
    return this.#templatesDir
      ? renderTemplate(templateName, vars, { templatesDir: this.#templatesDir })
      : renderTemplate(templateName, vars);
  }

  #requirePermission(session, action) {
    const check = this.#auth.perm.checkPermission({ userId: session.user.userId, action });
    if (!check.allowed) {
      throw new VmPanelError(PERMISSION_DENIED, `permission ditolak: ${action}`);
    }
  }

  /** Vars dasar halaman sesuai kontrak VARS templates: nav, user, banner, flash. */
  #pageVars(session, pathname, banner = '', extra = {}) {
    return {
      username: session?.user?.username ?? '',
      role: session?.user?.role ?? '',
      csrfToken: session?.csrfToken ?? '',
      nav: navHtml(pathname),
      user: session?.user?.username ?? '',
      banner: banner || '',
      flash: '',
      ...extra,
    };
  }

  #sendError(res, req, status, code, message) {
    if (String(req?.url ?? '').startsWith('/api/')) {
      return this.#sendJson(res, status, { error: { code, message } });
    }
    try {
      const html = this.#render('error', {
        title: `Error ${status}`,
        code,
        message,
        username: '',
        role: '',
        user: '',
        banner: '',
        flash: '',
      });
      return this.#sendHtml(res, status, html);
    } catch {
      return this.#sendHtml(
        res,
        status,
        `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Error ${status}</title></head>` +
          `<body><h1>${status}</h1><p>${escapeHtml(message)}</p></body></html>`,
      );
    }
  }

  #handleError(res, req, err) {
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {
        /* socket mati */
      }
      return;
    }
    let status = 500;
    let code = 'INTERNAL';
    let message = 'Terjadi kesalahan internal.';
    if (err instanceof VmPanelError) {
      status = STATUS_BY_CODE[err.code] ?? 500;
      code = err.code;
      if (status !== 500) message = err.message;
    }
    return this.#sendError(res, req, status, code, message);
  }

  // --- manager client (lazy, inject-able) ------------------------------------

  #getManager() {
    if (this.#managerClient) return this.#managerClient;
    if (!this.#defaultManager) {
      let token;
      try {
        token = readFileSync(this.#managerTokenFile, 'utf8').trim() || undefined;
      } catch {
        token = undefined;
      }
      this.#defaultManager = new ManagerClient({ port: this.#managerApiPort, token });
    }
    return this.#defaultManager;
  }

  /** Panggil manager; gagal apa pun → {ok:false} (halaman tetap render). */
  async #tryData(fn) {
    try {
      return { ok: true, data: await fn() };
    } catch {
      return { ok: false, data: null };
    }
  }

  /**
   * GET data dari manager via domain method bila tersedia (kompatibel mock
   * inject-able lama), fallback ke request() generik (ManagerClient nyata).
   */
  #managerGet(path, query = undefined) {
    const client = this.#getManager();
    const map = {
      '/system/status': () => client.systemStatus(),
      '/system/info': () => client.systemInfo(),
      '/health': () => client.health(),
      '/projects': () => client.listProjects(),
      '/audit': () => client.listAudit(query ?? {}),
    };
    const fn = map[path] ?? (() => client.request('GET', path, { query }));
    return this.#tryData(fn);
  }

  // --- routing utama -----------------------------------------------------------

  async #handle(req, res) {
    let pathname = '/';
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return this.#sendError(res, req, 400, VALIDATION, 'path tidak valid');
    }
    const ip = req.socket?.remoteAddress ?? 'unknown';
    const method = (req.method ?? 'GET').toUpperCase();
    // Static diroute pada RAW path (sebelum normalisasi URL) — traversal encoded
    // tidak boleh lolos; decode hanya di #serveStatic (resolve+prefix memblok).
    // /assets/ = alias lama; /static/ = prefix yang dipakai templates desainer.
    const rawPath = String(req.url ?? '/').split('?')[0];
    const staticPrefix = rawPath.startsWith('/assets/')
      ? '/assets/'
      : rawPath.startsWith('/static/')
        ? '/static/'
        : null;
    if (method === 'GET' && staticPrefix) {
      let rest;
      try {
        rest = decodeURIComponent(rawPath.slice(staticPrefix.length));
      } catch {
        return this.#sendError(res, req, 400, VALIDATION, 'path tidak valid');
      }
      return await this.#serveStatic(res, rest);
    }

    try {
      if (this.#isRateLimited(`g:${ip}`, this.#ratePerMin)) {
        return this.#sendError(res, req, 429, 'RATE_LIMITED', 'Terlalu banyak permintaan. Coba lagi nanti.');
      }

      if (method === 'GET' && pathname === '/login') {
        return this.#sendHtml(
          res,
          200,
          this.#render('login', { title: 'Login', error: '', username: '', banner: '', flash: '' }),
        );
      }
      if (method === 'POST' && pathname === '/login') {
        if (this.#isRateLimited(`login:${ip}`, this.#loginRatePerMin)) {
          return this.#sendError(res, req, 429, 'RATE_LIMITED', 'Terlalu banyak percobaan login. Coba lagi nanti.');
        }
        return await this.#handleLoginPost(req, res, ip);
      }

      // --- bootstrap first-run (sebelum session; hanya saat belum ada owner) ---
      if (pathname === '/bootstrap') {
        if (method === 'GET') return this.#handleBootstrapGet(res);
        if (method === 'POST') {
          if (this.#isRateLimited(`login:${ip}`, this.#loginRatePerMin)) {
            return this.#sendError(res, req, 429, 'RATE_LIMITED', 'Terlalu banyak percobaan. Coba lagi nanti.');
          }
          return await this.#handleBootstrapPost(req, res, ip);
        }
        return this.#sendError(res, req, 405, VALIDATION, 'method tidak didukung');
      }

      // --- terproteksi (session wajib) ---
      const cookies = this.#parseCookies(req);
      const session = this.#auth.getSession(cookies[SESSION_COOKIE]);
      if (!session) return this.#redirect(res, '/login');

      if (method === 'GET') {
        return await this.#handleProtectedGet(pathname, url.searchParams, session, res);
      }
      if (method === 'POST') {
        return await this.#handleProtectedPost(pathname, session, req, res, cookies, ip);
      }
      return this.#sendError(res, req, 405, VALIDATION, 'method tidak didukung');
    } catch (err) {
      return this.#handleError(res, req, err);
    }
  }

  // --- login -----------------------------------------------------------------

  async #handleLoginPost(req, res, ip) {
    const body = await this.#readParsedBody(req);
    // Template desainer memakai name="totp"; kontrak lama memakai totpCode — terima keduanya.
    const totpRaw = typeof body.totpCode === 'string' && body.totpCode !== '' ? body.totpCode : body.totp;
    const result = this.#auth.login({
      username: typeof body.username === 'string' ? body.username : '',
      password: typeof body.password === 'string' ? body.password : '',
      totpCode: typeof totpRaw === 'string' && totpRaw !== '' ? totpRaw : undefined,
      recoveryCode: typeof body.recoveryCode === 'string' ? body.recoveryCode : undefined,
      ip,
      secure: this.#isHttps(req),
    });
    if (!result.ok) {
      const status = result.reason === 'locked' ? 429 : 401;
      const message =
        result.reason === 'locked'
          ? 'Akun terkunci sementara (terlalu banyak percobaan gagal). Coba lagi nanti.'
          : result.reason === 'invalid_2fa'
            ? 'Kode verifikasi kedua (TOTP/recovery) tidak valid.'
            : 'Username atau password salah.';
      const html = this.#render('login', {
        title: 'Login',
        error: alertFrag('error', message),
        username: String(body.username ?? ''),
        banner: '',
        flash: '',
      });
      return this.#sendHtml(res, status, html);
    }
    res.setHeader('Set-Cookie', [result.sessionCookie, result.csrfCookie]);
    return this.#redirect(res, '/');
  }

  // --- bootstrap first-run -----------------------------------------------------

  /** True bila minimal satu user owner sudah ada (fail-closed saat cek gagal). */
  #hasOwner() {
    try {
      return this.#auth.listUsers().some((u) => u && u.role === 'owner');
    } catch {
      return true;
    }
  }

  /** Shell halaman bootstrap (kelas auth_* dari panel.css). */
  #pageShell(title, inner) {
    return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)} — VPANEL</title><link rel="stylesheet" href="/static/panel.css"><link rel="icon" href="${FAVICON_SVG}"></head><body class="auth"><main class="auth__wrap"><h1 class="sr-only">${escapeHtml(title)}</h1><div class="notices auth__notices"></div>${inner}</main><script src="/static/panel.js" defer></script></body></html>`;
  }

  #bootstrapFormHtml(error, token, username = 'admin') {
    const err = error ? alertFrag('error', error) : '';
    return this.#pageShell(
      'Setup owner',
      `<section class="auth__card"><div class="auth__brand"><span class="brand__mark">VPANEL</span><span class="auth__brand-sub">First-run setup — create the owner account</span></div>${err}<form class="auth__form" method="post" action="/bootstrap"><input type="hidden" name="token" value="${escapeHtml(token)}"><div class="field"><label class="field__label" for="b-username">Username</label><input class="field__input" type="text" id="b-username" name="username" value="${escapeHtml(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></div><div class="field"><label class="field__label" for="b-password">Password</label><input class="field__input" type="password" id="b-password" name="password" autocomplete="new-password" required minlength="8"></div><div class="field"><label class="field__label" for="b-confirm">Confirm password</label><input class="field__input" type="password" id="b-confirm" name="confirm" autocomplete="new-password" required minlength="8"></div><button class="btn btn--primary btn--block" type="submit">Create owner</button></form><p class="auth__note">Halaman ini hanya tersedia sebelum owner pertama dibuat. Token setup sekali-pakai (15 menit).</p></section>`,
    );
  }

  #bootstrapDoneHtml({ username, totpSecretBase32, recoveryCodes }) {
    const codes = (Array.isArray(recoveryCodes) ? recoveryCodes : [])
      .map((c) => `<li><code class="mono">${escapeHtml(c)}</code></li>`)
      .join('');
    return this.#pageShell(
      'Owner dibuat',
      `<section class="auth__card"><div class="auth__brand"><span class="brand__mark">VPANEL</span><span class="auth__brand-sub">Owner account created — store these secrets now</span></div><div class="alert alert--success" role="alert">Bootstrap selesai. Secret di bawah hanya ditampilkan sekali dan tidak pernah dicatat di log.</div><dl class="kv"><dt class="kv__key">Username</dt><dd class="kv__value mono">${escapeHtml(username)}</dd><dt class="kv__key">TOTP secret</dt><dd class="kv__value mono"><code id="bootstrap-totp">${escapeHtml(String(totpSecretBase32 ?? ''))}</code></dd></dl><div class="field"><span class="field__label">Recovery codes</span><ul class="stack" id="bootstrap-recovery">${codes}</ul><p class="field__hint">Satu kode sekali pakai, menggantikan kode TOTP saat login.</p></div><a class="btn btn--primary btn--block" href="/login">Sign in</a></section>`,
    );
  }

  #handleBootstrapGet(res) {
    if (this.#hasOwner()) return this.#redirect(res, '/login');
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    for (const [k, exp] of this.#bootstrapTokens) {
      if (exp <= now) this.#bootstrapTokens.delete(k);
    }
    this.#bootstrapTokens.set(token, now + BOOTSTRAP_TTL_MS);
    return this.#sendHtml(res, 200, this.#bootstrapFormHtml('', token));
  }

  async #handleBootstrapPost(req, res, ip) {
    void ip;
    const body = await this.#readParsedBody(req);
    const token = String(body.token ?? '');
    const username = String(body.username ?? '').trim() || 'admin';
    const password = typeof body.password === 'string' ? body.password : '';
    const confirm = typeof body.confirm === 'string' ? body.confirm : '';

    const reissue = (error, status = 400) => {
      const fresh = randomBytes(32).toString('hex');
      this.#bootstrapTokens.set(fresh, Date.now() + BOOTSTRAP_TTL_MS);
      return this.#sendHtml(res, status, this.#bootstrapFormHtml(error, fresh, username));
    };

    if (this.#hasOwner()) {
      throw new VmPanelError(PERMISSION_DENIED, 'bootstrap sudah dilakukan (owner sudah ada)');
    }
    const expiresAt = this.#bootstrapTokens.get(token);
    this.#bootstrapTokens.delete(token); // sekali pakai
    if (!expiresAt || expiresAt <= Date.now()) {
      return reissue('Token setup tidak valid atau kedaluwarsa. Muat ulang halaman setup.');
    }
    if (password.length < 8) return reissue('Password minimal 8 karakter.');
    if (password !== confirm) return reissue('Password dan konfirmasi tidak sama.');

    let boot;
    try {
      boot = this.#auth.bootstrapOwner({ username, password });
    } catch (e) {
      if (e instanceof VmPanelError) return reissue(e.message, 400);
      throw e;
    }
    // TOTP secret + recovery codes tampil SEKALI di halaman ini — tidak ke
    // log/audit (PanelAuth hanya mengaudit metadata PANEL_BOOTSTRAP).
    return this.#sendHtml(res, 200, this.#bootstrapDoneHtml(boot));
  }

  // --- static ----------------------------------------------------------------

  async #serveStatic(res, rest) {
    const base = this.#staticDir;
    const target = resolve(base, rest);
    if (target !== base && !target.startsWith(base + sep)) {
      return this.#sendError(res, { url: '/static/' }, 403, PERMISSION_DENIED, 'path di luar direktori static');
    }
    const type = STATIC_TYPES[extname(target).toLowerCase()];
    if (!type) {
      return this.#sendError(res, { url: '/static/' }, 404, NOT_FOUND, 'file static tidak ditemukan');
    }
    let data;
    try {
      data = await readFile(target);
    } catch {
      return this.#sendError(res, { url: '/static/' }, 404, NOT_FOUND, 'file static tidak ditemukan');
    }
    if (res.headersSent) return;
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  }

  // --- halaman terproteksi (GET) ----------------------------------------------

  async #handleProtectedGet(pathname, searchParams, session, res) {
    if (pathname === '/' || pathname === '/dashboard') {
      return this.#renderManaged(res, await this.#pageDashboard(session, pathname));
    }
    if (pathname === '/projects') return this.#renderManaged(res, await this.#pageProjects(session, pathname));
    const detail = pathname.match(/^\/projects\/([^/]+)$/);
    if (detail) return this.#renderManaged(res, await this.#pageProjectDetail(session, detail[1], '/projects'));
    if (pathname === '/services') return this.#renderManaged(res, await this.#pageServices(session, pathname));
    if (pathname === '/deployments') return this.#renderManaged(res, await this.#pageDeployments(session, pathname));
    if (pathname === '/health') return this.#renderManaged(res, await this.#pageHealth(session, pathname));
    if (pathname === '/recovery') return this.#renderManaged(res, await this.#pageRecovery(session, pathname));
    if (pathname === '/backups') return this.#renderManaged(res, await this.#pageBackups(session, pathname));
    if (pathname === '/audit') return this.#renderManaged(res, await this.#pageAudit(session, pathname, searchParams));
    if (pathname === '/logs') return this.#renderManaged(res, await this.#pageLogs(session, pathname, searchParams));
    if (pathname === '/users') return this.#renderManaged(res, this.#pageUsers(session, pathname));
    if (pathname === '/settings') return this.#renderManaged(res, await this.#pageSettings(session, pathname));
    if (pathname === '/logout') return this.#redirect(res, '/login'); // logout asli via POST (CSRF)
    return this.#sendError(res, { url: pathname }, 404, NOT_FOUND, 'halaman tidak ditemukan');
  }

  #renderManaged(res, page) {
    let html;
    try {
      html = this.#render(page.template, page.vars);
    } catch (e) {
      // fallback nama template lama (mis. project_detail vs project-detail)
      if (page.altTemplate && e instanceof VmPanelError && e.code === NOT_FOUND) {
        html = this.#render(page.altTemplate, page.vars);
      } else {
        throw e;
      }
    }
    return this.#sendHtml(res, page.status ?? 200, html);
  }

  async #pageDashboard(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/']);
    const [status, projects, services] = await Promise.all([
      this.#managerGet('/system/status'),
      this.#managerGet('/projects'),
      this.#managerGet('/services'),
    ]);
    const rows = Array.isArray(projects.data) ? projects.data : [];
    const banner = status.ok && projects.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);

    const st = status.ok && status.data && typeof status.data === 'object' ? status.data : null;
    const cpus = Math.max(os.cpus().length, 1);
    const loadPct = clampPct((os.loadavg()[0] / cpus) * 100);
    const memPct = clampPct(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

    const systemCards = `<div class="grid grid--3">` +
      `<section class="card"><header class="card__header"><h2 class="card__title">System status</h2></header><div class="card__body"><dl class="kv">` +
      `<dt class="kv__key">Manager</dt><dd class="kv__value">${statusCell(st?.status ?? 'unknown')}</dd>` +
      `<dt class="kv__key">Uptime</dt><dd class="kv__value mono">${escapeHtml(st ? fmtDuration(st.uptimeSec) : '—')}</dd>` +
      `<dt class="kv__key">Host mode</dt><dd class="kv__value mono">${escapeHtml(String(st?.hostMode ?? '—'))}</dd>` +
      `<dt class="kv__key">Version</dt><dd class="kv__value mono">${escapeHtml(String(st?.version ?? '—'))}</dd>` +
      `<dt class="kv__key">PID</dt><dd class="kv__value mono">${escapeHtml(String(st?.pid ?? '—'))}</dd>` +
      `</dl></div></section>` +
      `<section class="card"><header class="card__header"><h2 class="card__title">Resources</h2></header><div class="card__body">` +
      `${barHtml('CPU load (advisory)', loadPct)}${barHtml('Memory used (advisory)', memPct)}` +
      `<p class="field__hint">Host CPU/RAM via node:os — advisory, sampled on page load.</p>` +
      `</div></section>` +
      `<section class="card"><header class="card__header"><h2 class="card__title">Runner</h2></header><div class="card__body"><dl class="kv">` +
      `<dt class="kv__key">Runner ID</dt><dd class="kv__value mono">${escapeHtml(String(st?.runnerId ?? '—'))}</dd>` +
      `<dt class="kv__key">Phase</dt><dd class="kv__value mono">${escapeHtml(String(st?.status ?? 'unknown'))}</dd>` +
      `<dt class="kv__key">Started</dt><dd class="kv__value mono">${fmtTime(st?.startedAt ?? null)}</dd>` +
      `</dl></div></section></div>`;

    // Alerts: checks gagal/warn per service (best-effort; kosong → empty state).
    const alerts = [];
    const svcRows = services.ok && Array.isArray(services.data?.rows) ? services.data.rows : [];
    const targets = svcRows.slice(0, 20);
    const states = await Promise.all(targets.map((s) => this.#managerGet('/health-state', { serviceId: s.id })));
    for (let i = 0; i < targets.length; i++) {
      const d = states[i].ok ? states[i].data : null;
      if (!d || !Array.isArray(d.checks)) continue;
      for (const c of d.checks) {
        const res = String(c.result ?? '').toLowerCase();
        if (res !== 'fail' && res !== 'warn' && res !== 'timeout') continue;
        alerts.push({
          at: c.at,
          level: res,
          projectId: c.project_id ?? targets[i].projectId ?? '',
          message: c.error ?? `${c.check_type ?? 'check'} ${res}`,
        });
      }
    }
    alerts.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    const alertsTable =
      alerts.length === 0
        ? emptyState({ title: 'No recent alerts.', hint: 'Alerts appear when checks fail or thresholds are exceeded.' })
        : buildTable(
            [
              { label: 'Time UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.at)) },
              { label: 'Level', cell: (r) => badgeHtml(r.level, r.level === 'warn' ? 'warn' : 'err') },
              { label: 'Project', cls: 'mono', cell: (r) => escapeHtml(String(r.projectId || '—')) },
              { label: 'Message', cls: 'mono muted', cell: (r) => escapeHtml(String(r.message || '')) },
            ],
            alerts.slice(0, 10),
          );

    return {
      template: 'dashboard',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Dashboard',
        managerStatus: status.ok ? String(status.data?.status ?? 'unknown') : 'unknown',
        projectCount: String(rows.length),
        rows,
        rowsJson: JSON.stringify(rows),
        systemCards,
        alertsTable,
      }),
    };
  }

  async #pageProjects(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/projects']);
    const [projects, services, deployments] = await Promise.all([
      this.#managerGet('/projects'),
      this.#managerGet('/services'),
      this.#managerGet('/deployments', { limit: 100 }),
    ]);
    const rows = Array.isArray(projects.data) ? projects.data : [];
    const portByProject = new Map();
    if (services.ok && Array.isArray(services.data?.rows)) {
      for (const s of services.data.rows) {
        if (s?.projectId && s.port != null && !portByProject.has(s.projectId)) portByProject.set(s.projectId, s.port);
      }
    }
    const lastDeploy = new Map();
    if (deployments.ok && Array.isArray(deployments.data?.rows)) {
      for (const d of deployments.data.rows) {
        const pid = d?.project_id;
        if (pid && !lastDeploy.has(pid)) lastDeploy.set(pid, d.started_at ?? d.finished_at ?? '');
      }
    }
    const banner = projects.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const projectsTable = buildTable(
      [
        { label: 'ID', cls: 'mono', cell: (r) => escapeHtml(String(r.id ?? '')) },
        { label: 'Name', cell: (r) => `<a href="/projects/${encodeURIComponent(String(r.id ?? ''))}">${escapeHtml(String(r.name ?? r.id ?? ''))}</a>` },
        { label: 'Type', cell: (r) => badgeHtml(r.type ?? '') },
        { label: 'Status', cell: (r) => statusCell(r.status) },
        { label: 'Port', cls: 'mono', cell: (r) => escapeHtml(String(portByProject.get(r.id) ?? '—')) },
        { label: 'Last deploy', cls: 'mono', cell: (r) => escapeHtml(lastDeploy.has(r.id) ? fmtTime(lastDeploy.get(r.id)) : '—') },
      ],
      rows,
      { empty: { title: 'No projects registered.', hint: 'Create one via vmctl project create.' } },
    );
    return {
      template: 'projects',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Projects',
        rows,
        rowsJson: JSON.stringify(rows),
        projectsTable,
      }),
    };
  }

  async #pageProjectDetail(session, id, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/projects']);
    const [projects, services, deployments] = await Promise.all([
      this.#managerGet('/projects'),
      this.#managerGet('/services'),
      this.#managerGet('/deployments', { limit: 50 }),
    ]);
    const rows = Array.isArray(projects.data) ? projects.data : [];
    const project = rows.find((p) => p && String(p.id ?? '') === String(id));
    const svcRows =
      services.ok && Array.isArray(services.data?.rows)
        ? services.data.rows.filter((s) => s && String(s.projectId ?? '') === String(id))
        : [];
    const depRows =
      deployments.ok && Array.isArray(deployments.data?.rows)
        ? deployments.data.rows.filter((d) => d && String(d.project_id ?? '') === String(id))
        : [];
    const banner = projects.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const svc = svcRows[0] ?? null;

    let overviewGrid;
    if (project) {
      const status = String(project.status ?? 'unknown');
      const rev = String(depRows[0]?.revision ?? '');
      overviewGrid =
        `<section class="card"><header class="card__header"><h2 class="card__title">` +
        `<span class="status"><span class="dot ${dotClass(status)}" role="img" aria-label="status: ${escapeHtml(status)}"></span>${escapeHtml(String(project.name ?? id))}</span></h2>` +
        `<span class="mono muted">${escapeHtml(String(id))}</span></header><div class="card__body"><dl class="kv">` +
        `<dt class="kv__key">Type</dt><dd class="kv__value">${badgeHtml(project.type ?? '', 'accent')}</dd>` +
        `<dt class="kv__key">Status</dt><dd class="kv__value">${statusCell(status)}</dd>` +
        `<dt class="kv__key">Revision</dt><dd class="kv__value mono">${escapeHtml(rev || '—')}</dd>` +
        `<dt class="kv__key">Port</dt><dd class="kv__value mono">${escapeHtml(String(svc?.port ?? '—'))}</dd>` +
        `<dt class="kv__key">Created</dt><dd class="kv__value mono">${fmtTime(project.createdAt)}</dd>` +
        `<dt class="kv__key">Workspace</dt><dd class="kv__value mono">${escapeHtml(String(svc?.config?.rootDir ?? svc?.rootDir ?? '—'))}</dd>` +
        `</dl></div></section>`;
    } else {
      overviewGrid = emptyState({ title: 'Project not found.', hint: 'Periksa ID atau kembali ke daftar projects.' });
    }

    const depTable = buildTable(
      [
        { label: 'ID', cls: 'mono', cell: (r) => escapeHtml(String(r.id ?? '')) },
        { label: 'Revision', cls: 'mono', cell: (r) => escapeHtml(String(r.revision ?? '—')) },
        { label: 'Status', cell: (r) => badgeHtml(r.status ?? '', deployBadgeVariant(r.status)) },
        { label: 'Actor', cell: (r) => escapeHtml(String(r.actor ?? '—')) },
        { label: 'Started UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.started_at)) },
        { label: 'Finished UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.finished_at)) },
      ],
      depRows,
      { empty: { title: 'No deployments yet.' } },
    );

    let healthState = null;
    if (svc) {
      const hs = await this.#managerGet('/health-state', { serviceId: svc.id });
      if (hs.ok && hs.data) healthState = hs.data;
    }
    const checkRows = Array.isArray(healthState?.checks) ? healthState.checks.slice(0, 10) : [];
    const stateStatus = String(healthState?.status?.status ?? 'unknown');
    const healthSection = svc
      ? `<section class="card"><header class="card__header"><h2 class="card__title">${escapeHtml(String(svc.name ?? svc.id))} ${statusCell(stateStatus)}</h2><span class="mono muted">${escapeHtml(String(svc.id))}</span></header><div class="card__body">` +
        buildTable(
          [
            { label: 'Time UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.at)) },
            { label: 'Type', cls: 'mono', cell: (r) => escapeHtml(String(r.check_type ?? '—')) },
            { label: 'Latency', cls: 'mono', cell: (r) => escapeHtml(r.latency_ms == null ? '—' : `${r.latency_ms} ms`) },
            { label: 'Result', cell: (r) => badgeHtml(r.result ?? '', resultBadgeVariant(r.result)) },
            { label: 'Detail', cls: 'mono muted', cell: (r) => escapeHtml(String(r.error ?? '')) },
          ],
          checkRows,
          { empty: { title: 'No checks recorded.' } },
        ) +
        `</div></section>`
      : emptyState({ title: 'No health data.', hint: 'Health checks appear once the project is deployed.' });

    let logsSection;
    if (svc) {
      const logs = await this.#managerGet(`/logs/${encodeURIComponent(String(svc.id))}`);
      logsSection =
        logs.ok && Array.isArray(logs.data?.lines)
          ? `<pre class="log" tabindex="0" data-autoscroll aria-label="Log output">${escapeHtml(logs.data.lines.join('\n'))}</pre>`
          : emptyState({ title: 'No log output.', hint: 'Output appears once the service writes to it.' });
    } else {
      logsSection = emptyState({ title: 'No log output.' });
    }

    const settingsForm = svc
      ? `<section class="card"><header class="card__header"><h2 class="card__title">Settings (read-only)</h2></header><div class="card__body"><dl class="kv">` +
        `<dt class="kv__key">Restart policy</dt><dd class="kv__value mono">${escapeHtml(String(svc.restartPolicy ?? svc.config?.restartPolicy ?? '—'))}</dd>` +
        `<dt class="kv__key">Health check</dt><dd class="kv__value mono">${escapeHtml(svc.healthCheck ? JSON.stringify(svc.healthCheck) : svc.config?.healthCheck ? JSON.stringify(svc.config.healthCheck) : '—')}</dd>` +
        `<dt class="kv__key">Port</dt><dd class="kv__value mono">${escapeHtml(String(svc.port ?? '—'))}</dd>` +
        `<dt class="kv__key">Enabled</dt><dd class="kv__value mono">${escapeHtml(svc.enabled ? 'yes' : 'no')}</dd>` +
        `</dl></div></section>`
      : emptyState({ title: 'No settings.', hint: 'Settings appear once the project is deployed.' });

    return {
      template: 'project-detail',
      altTemplate: 'project_detail',
      vars: this.#pageVars(session, pathname, banner, {
        title: `Project ${id}`,
        itemId: String(id),
        found: project ? 'yes' : 'no',
        note: project ? '' : ENDPOINT_TODO_NOTE,
        projectJson: JSON.stringify(project ?? null),
        overviewGrid,
        deploymentsTable: depTable,
        healthSection,
        logsSection,
        settingsForm,
      }),
    };
  }

  async #pageServices(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/services']);
    const services = await this.#managerGet('/services');
    const rows = services.ok && Array.isArray(services.data?.rows) ? services.data.rows : [];
    const banner = services.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const csrf = session.csrfToken;
    const servicesTable = buildTable(
      [
        { label: 'ID', cls: 'mono', cell: (r) => escapeHtml(String(r.id ?? '')) },
        { label: 'Project', cell: (r) => `<a href="/projects/${encodeURIComponent(String(r.projectId ?? ''))}">${escapeHtml(String(r.name ?? r.projectId ?? ''))}</a>` },
        { label: 'Status', cell: (r) => statusCell(r.status) },
        { label: 'PID', cls: 'mono', cell: (r) => escapeHtml(String(r.pid ?? '—')) },
        { label: 'Port', cls: 'mono', cell: (r) => escapeHtml(String(r.port ?? '—')) },
        { label: 'Actions', cell: (r) => serviceActions(r, csrf) },
      ],
      rows,
      { empty: { title: 'No services.', hint: 'Services appear once a project has been deployed.' } },
    );
    return {
      template: 'services',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Services',
        servicesTable,
        note: services.ok ? '' : ENDPOINT_TODO_NOTE,
      }),
    };
  }

  async #pageDeployments(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/deployments']);
    const [deployments, projects] = await Promise.all([
      this.#managerGet('/deployments', { limit: 50 }),
      this.#managerGet('/projects'),
    ]);
    const rows = deployments.ok && Array.isArray(deployments.data?.rows) ? deployments.data.rows : [];
    const nameByProject = new Map(
      Array.isArray(projects.data) ? projects.data.map((p) => [p?.id, p?.name]) : [],
    );
    const banner = deployments.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const deploymentsTable = buildTable(
      [
        { label: 'ID', cls: 'mono', cell: (r) => escapeHtml(String(r.id ?? '')) },
        { label: 'Project', cell: (r) => `<a href="/projects/${encodeURIComponent(String(r.project_id ?? ''))}">${escapeHtml(String(nameByProject.get(r.project_id) ?? r.project_id ?? ''))}</a>` },
        { label: 'Revision', cls: 'mono', cell: (r) => escapeHtml(String(r.revision ?? '—')) },
        { label: 'Status', cell: (r) => badgeHtml(r.status ?? '', deployBadgeVariant(r.status)) },
        { label: 'Actor', cell: (r) => escapeHtml(String(r.actor ?? '—')) },
        { label: 'Started UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.started_at)) },
        { label: 'Finished UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.finished_at)) },
      ],
      rows,
      { empty: { title: 'No deployments.', hint: 'Deployments appear after the first deploy of a project.' } },
    );
    return {
      template: 'deployments',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Deployments',
        deploymentsTable,
        note: deployments.ok ? '' : ENDPOINT_TODO_NOTE,
      }),
    };
  }

  async #pageHealth(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/health']);
    const services = await this.#managerGet('/services');
    const rows = services.ok && Array.isArray(services.data?.rows) ? services.data.rows : [];
    const banner = services.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    let healthSections;
    if (rows.length === 0) {
      healthSections = emptyState({ title: 'No health data.', hint: 'Health checks appear once services are deployed.' });
    } else {
      const targets = rows.slice(0, 20);
      const states = await Promise.all(targets.map((s) => this.#managerGet('/health-state', { serviceId: s.id })));
      healthSections = targets
        .map((s, i) => {
          const d = states[i].ok ? states[i].data : null;
          const stateStatus = String(d?.status?.status ?? 'unknown');
          const checks = Array.isArray(d?.checks) ? d.checks.slice(0, 10) : [];
          const table = buildTable(
            [
              { label: 'Time UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.at)) },
              { label: 'Type', cls: 'mono', cell: (r) => escapeHtml(String(r.check_type ?? '—')) },
              { label: 'Latency', cls: 'mono', cell: (r) => escapeHtml(r.latency_ms == null ? '—' : `${r.latency_ms} ms`) },
              { label: 'Result', cell: (r) => badgeHtml(r.result ?? '', resultBadgeVariant(r.result)) },
              { label: 'Detail', cls: 'mono muted', cell: (r) => escapeHtml(String(r.error ?? '')) },
            ],
            checks,
            { empty: { title: 'No checks recorded.' } },
          );
          return (
            `<section class="card"><header class="card__header"><h2 class="card__title">${escapeHtml(String(s.name ?? s.id))} ${statusCell(stateStatus)}</h2><span class="mono muted">${escapeHtml(String(s.id))}</span></header><div class="card__body">${table}</div></section>`
          );
        })
        .join('');
    }
    return {
      template: 'health',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Health',
        managerHealth: services.ok ? 'ok' : 'unreachable',
        healthSections,
      }),
    };
  }

  async #pageRecovery(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/recovery']);
    const recovery = await this.#managerGet('/recovery/status');
    const rows = recovery.ok && Array.isArray(recovery.data?.rows) ? recovery.data.rows : [];
    const banner = recovery.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const csrf = session.csrfToken;
    const crashers = rows.filter(
      (r) => r?.supervisor?.crashLoop === true || String(r?.supervisor?.state ?? '') === 'crash_loop',
    );
    const recoverySections =
      crashers.length === 0
        ? emptyState({ title: 'No services in crash-loop.', hint: 'The supervisor is operating within restart limits.' })
        : crashers
            .map((r) => {
              const sup = r.supervisor ?? {};
              return (
                `<section class="card"><header class="card__header"><h2 class="card__title"><span class="status"><span class="dot dot--crash_loop" role="img" aria-label="status: crash loop"></span>${escapeHtml(String(r.name ?? r.serviceId))}</span></h2><span class="mono muted">${escapeHtml(String(r.serviceId ?? ''))}</span></header>` +
                `<div class="card__body"><dl class="kv">` +
                `<dt class="kv__key">Status</dt><dd class="kv__value">${statusCell(r.status)}</dd>` +
                `<dt class="kv__key">Restart count</dt><dd class="kv__value mono">${escapeHtml(String(sup.restartCount ?? 0))}</dd>` +
                `<dt class="kv__key">Backoff until</dt><dd class="kv__value mono">${fmtTime(sup.backoffUntil)}</dd>` +
                `</dl>` +
                actionForm(`/services/${encodeURIComponent(String(r.serviceId ?? ''))}/retry`, {
                  label: 'Manual retry',
                  cls: 'btn btn--danger',
                  confirm: `Manually retry service ${r.name ?? r.serviceId}?`,
                  detail: undefined,
                  phrase: String(r.serviceId ?? ''),
                  csrf,
                }) +
                `</div></section>`
              );
            })
            .join('');
    return {
      template: 'recovery',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Recovery',
        recoverySections,
        note: recovery.ok ? '' : ENDPOINT_TODO_NOTE,
      }),
    };
  }

  async #pageBackups(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/backups']);
    const backups = await this.#managerGet('/backups', { limit: 50 });
    const rows = backups.ok && Array.isArray(backups.data?.rows) ? backups.data.rows : [];
    const banner = backups.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const csrf = session.csrfToken;
    let canCreate = false;
    try {
      canCreate = this.#auth.perm.checkPermission({ userId: session.user.userId, action: 'backup.create' }).allowed;
    } catch {
      canCreate = false;
    }
    const backupControls = canCreate
      ? `<section class="card"><header class="card__header"><h2 class="card__title">Backup controls</h2></header><div class="card__body"><div class="page__actions"><form method="post" action="/backups">${csrfInput(csrf)}<button class="btn btn--primary" type="submit" data-confirm="Create a backup now?">Create backup</button></form></div><p class="field__hint">Backups pause deployments while running. Manual backups are never deleted by retention.</p></div></section>`
      : '';
    const backupsTable = buildTable(
      [
        { label: 'ID', cls: 'mono', cell: (r) => escapeHtml(String(r.id ?? '')) },
        { label: 'Class', cell: (r) => badgeHtml(r.retention_class ?? '') },
        { label: 'Size', cls: 'mono', cell: (r) => escapeHtml(fmtBytes(r.file_size)) },
        { label: 'SHA-256 (8)', cls: 'mono', cell: (r) => escapeHtml(String(r.sha256 ? String(r.sha256).slice(0, 8) : '—')) },
        { label: 'Verified', cell: (r) => badgeHtml(r.verification_status ?? '', verifyBadgeVariant(r.verification_status)) },
        { label: 'Created UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.at)) },
      ],
      rows,
      { empty: { title: 'No backups.', hint: 'Create one manually or wait for the scheduled backup.' } },
    );
    return {
      template: 'backups',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Backups',
        backupControls,
        backupsTable,
        note: backups.ok ? '' : ENDPOINT_TODO_NOTE,
      }),
    };
  }

  async #pageAudit(session, pathname, searchParams) {
    this.#requirePermission(session, PAGE_ACTIONS['/audit']);
    const actorQ = String(searchParams.get('actor') ?? '');
    const opQ = String(searchParams.get('operation') ?? '');
    const resultQ = String(searchParams.get('result') ?? '');
    const query = { limit: 50 };
    if (actorQ) query.actor = actorQ;
    if (opQ) query.operation = opQ;
    const audit = await this.#managerGet('/audit', query);
    let rows = audit.ok && Array.isArray(audit.data?.rows) ? audit.data.rows : [];
    if (resultQ) rows = rows.filter((r) => String(r?.result ?? '') === resultQ);
    const total = audit.ok ? String(audit.data?.total ?? rows.length) : '0';
    const banner = audit.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const filterForm =
      `<section class="card"><header class="card__header"><h2 class="card__title">Filters</h2></header><div class="card__body"><form class="filters" method="get" action="/audit">` +
      `<div class="field"><label class="field__label" for="f-actor">Actor</label><input class="field__input" type="text" id="f-actor" name="actor" value="${escapeHtml(actorQ)}"></div>` +
      `<div class="field"><label class="field__label" for="f-operation">Operation</label><input class="field__input mono" type="text" id="f-operation" name="operation" value="${escapeHtml(opQ)}"></div>` +
      `<div class="field"><label class="field__label" for="f-result">Result</label><select class="field__input" id="f-result" name="result"><option value="">all</option><option value="ok"${resultQ === 'ok' ? ' selected' : ''}>ok</option><option value="fail"${resultQ === 'fail' ? ' selected' : ''}>fail</option></select></div>` +
      `<button class="btn" type="submit">Apply</button></form></div></section>`;
    const auditTable = buildTable(
      [
        { label: 'Time UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.at)) },
        { label: 'Actor', cell: (r) => escapeHtml(String(r.actor ?? '—')) },
        { label: 'Operation', cls: 'mono', cell: (r) => escapeHtml(String(r.operation ?? '')) },
        { label: 'Project', cls: 'mono', cell: (r) => escapeHtml(String(r.projectId ?? '—')) },
        { label: 'Result', cell: (r) => badgeHtml(r.result ?? '', auditBadgeVariant(r.result)) },
      ],
      rows,
      { empty: { title: 'No audit events match.', hint: 'Adjust or clear the filters.' } },
    );
    return {
      template: 'audit',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Audit',
        total,
        rows,
        rowsJson: JSON.stringify(rows),
        filterForm,
        auditTable,
      }),
    };
  }

  async #pageLogs(session, pathname, searchParams) {
    this.#requirePermission(session, PAGE_ACTIONS['/logs']);
    const services = await this.#managerGet('/services');
    const svcRows = services.ok && Array.isArray(services.data?.rows) ? services.data.rows : [];
    const selected = String(searchParams.get('serviceId') ?? '').trim();
    const banner = services.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const options = svcRows
      .map(
        (s) =>
          `<option value="${escapeHtml(String(s.id))}"${String(s.id) === selected ? ' selected' : ''}>${escapeHtml(String(s.name ?? s.id))}</option>`,
      )
      .join('');
    const logSelector =
      `<section class="card"><header class="card__header"><h2 class="card__title">Log file</h2></header><div class="card__body"><form class="filters" method="get" action="/logs">` +
      `<div class="field"><label class="field__label" for="log-file">File</label><select class="field__input field__input--mono" id="log-file" name="serviceId">${options || '<option value="">(no services)</option>'}</select></div>` +
      `<button class="btn" type="submit">Open</button></form></div></section>`;
    let logContent;
    if (selected === '') {
      logContent = emptyState({ title: 'Log file is empty.', hint: 'Pick a service above and press Open.' });
    } else if (!/^[A-Za-z0-9._-]+$/.test(selected)) {
      throw new VmPanelError(VALIDATION, 'serviceId tidak valid');
    } else {
      const logs = await this.#managerGet(`/logs/${encodeURIComponent(selected)}`);
      if (logs.ok && Array.isArray(logs.data?.lines)) {
        logContent = `<pre class="log" tabindex="0" data-autoscroll aria-label="Log output">${escapeHtml(logs.data.lines.join('\n'))}</pre>`;
        if (logs.data.truncated) {
          logContent =
            alertFrag('info', `Log ditampilkan ${logs.data.lines.length} baris terakhir dari total ${logs.data.total}.`) +
            logContent;
        }
      } else {
        logContent = emptyState({ title: 'Log file is empty.', hint: 'Output appears once the component writes to it.' });
      }
    }
    return {
      template: 'logs',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Logs',
        logSelector,
        logContent,
        note: services.ok ? '' : ENDPOINT_TODO_NOTE,
      }),
    };
  }

  #pageUsers(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/users']);
    const rows = this.#auth.listUsers();
    const csrf = session.csrfToken;
    const usersTable = buildTable(
      [
        { label: 'Username', cell: (r) => escapeHtml(String(r.username ?? '')) },
        { label: 'Role', cell: (r) => badgeHtml(r.role ?? '', r.role === 'owner' ? 'accent' : '') },
        {
          label: 'Status',
          cell: (r) => {
            const s = String(r.status ?? 'unknown');
            return `<span class="status"><span class="dot ${userDotClass(s)}" role="img" aria-label="status: ${escapeHtml(s)}"></span>${escapeHtml(s)}</span>`;
          },
        },
        { label: 'Last login UTC', cls: 'mono', cell: (r) => escapeHtml(fmtTime(r.lastLoginAt)) },
      ],
      rows,
      { empty: { title: 'No users.' } },
    );
    const isOwner = session.user.role === 'owner';
    const usersAdminForm = isOwner
      ? `<section class="card"><header class="card__header"><h2 class="card__title">User administration</h2></header><div class="card__body"><div class="stack">` +
        `<form method="post" action="/users"><input type="hidden" name="action" value="create-user">${csrfInput(csrf)}<div class="field"><label class="field__label" for="u-username">Username</label><input class="field__input" id="u-username" name="username" autocomplete="off" spellcheck="false" required></div><div class="field"><label class="field__label" for="u-role">Role</label><select class="field__input" id="u-role" name="role"><option value="viewer">viewer</option><option value="operator">operator</option><option value="owner">owner</option></select></div><button class="btn btn--primary" type="submit">Create user</button></form>` +
        `<form method="post" action="/users"><input type="hidden" name="action" value="approve-user">${csrfInput(csrf)}<div class="field"><label class="field__label" for="u-approve">Username (approve)</label><input class="field__input" id="u-approve" name="username" autocomplete="off" required></div><button class="btn" type="submit">Approve user</button></form>` +
        `<form method="post" action="/users"><input type="hidden" name="action" value="set-role">${csrfInput(csrf)}<div class="field"><label class="field__label" for="u-setrole-user">Username (set role)</label><input class="field__input" id="u-setrole-user" name="username" autocomplete="off" required></div><div class="field"><label class="field__label" for="u-setrole">Role</label><select class="field__input" id="u-setrole" name="role"><option value="viewer">viewer</option><option value="operator">operator</option><option value="owner">owner</option></select></div><button class="btn" type="submit">Set role</button></form>` +
        `</div></div></section>`
      : '';
    return {
      template: 'users',
      vars: this.#pageVars(session, pathname, '', {
        title: 'Users',
        rows,
        rowsJson: JSON.stringify(rows),
        usersTable,
        usersAdminForm,
      }),
    };
  }

  async #pageSettings(session, pathname) {
    this.#requirePermission(session, PAGE_ACTIONS['/settings']);
    const [status, info] = await Promise.all([
      this.#managerGet('/system/status'),
      this.#managerGet('/system/info'),
    ]);
    const st = status.ok ? status.data : null;
    const inf = info.ok ? info.data : null;
    const banner = status.ok && info.ok ? '' : alertFrag('warn', MANAGER_DOWN_BANNER);
    const settingsGrid =
      `<div class="grid grid--2">` +
      `<section class="card"><header class="card__header"><h2 class="card__title">System</h2></header><div class="card__body"><dl class="kv">` +
      `<dt class="kv__key">Panel version</dt><dd class="kv__value mono">0.1.0</dd>` +
      `<dt class="kv__key">Node</dt><dd class="kv__value mono">${escapeHtml(process.version)}</dd>` +
      `<dt class="kv__key">Platform</dt><dd class="kv__value mono">${escapeHtml(`${process.platform} ${process.arch}`)}</dd>` +
      `<dt class="kv__key">Manager</dt><dd class="kv__value">${statusCell(st?.status ?? 'unknown')}</dd>` +
      `<dt class="kv__key">Manager version</dt><dd class="kv__value mono">${escapeHtml(String(inf?.version ?? '—'))}</dd>` +
      `<dt class="kv__key">Manager uptime</dt><dd class="kv__value mono">${escapeHtml(st ? fmtDuration(st.uptimeSec) : '—')}</dd>` +
      `<dt class="kv__key">Data dir</dt><dd class="kv__value mono">${escapeHtml(String(inf?.dataDir ?? '—'))}</dd>` +
      `</dl></div></section>` +
      `<section class="card"><header class="card__header"><h2 class="card__title">Limits</h2></header><div class="card__body"><dl class="kv">` +
      `<dt class="kv__key">Rate limit</dt><dd class="kv__value mono">${this.#ratePerMin} req/min</dd>` +
      `<dt class="kv__key">Login rate</dt><dd class="kv__value mono">${this.#loginRatePerMin}/min</dd>` +
      `<dt class="kv__key">Bind</dt><dd class="kv__value mono">127.0.0.1:${this.port}</dd>` +
      `</dl></div></section></div>`;
    return {
      template: 'settings',
      vars: this.#pageVars(session, pathname, banner, {
        title: 'Settings',
        settingsGrid,
        note: status.ok ? '' : ENDPOINT_TODO_NOTE,
      }),
    };
  }

  // --- aksi terproteksi (POST) -------------------------------------------------

  #csrfFromReq(req, body) {
    const header = req.headers['x-csrf-token'];
    if (typeof header === 'string' && header !== '') return header;
    const b = body?._csrf ?? body?.csrf_token;
    return typeof b === 'string' ? b : undefined;
  }

  #csrfOk(session, cookies, provided) {
    if (typeof provided !== 'string' || provided === '') return false;
    if (cookies[CSRF_COOKIE] !== provided) return false; // double-submit cookie
    return this.#auth.validateCsrf(session, provided); // + binding ke session
  }

  async #handleProtectedPost(pathname, session, req, res, cookies, ip) {
    const readAndCsrf = async () => {
      const body = await this.#readParsedBody(req);
      if (!this.#csrfOk(session, cookies, this.#csrfFromReq(req, body))) {
        throw new VmPanelError(PERMISSION_DENIED, 'CSRF token tidak valid');
      }
      return body;
    };

    if (pathname === '/logout') {
      await readAndCsrf();
      this.#auth.logout(session.sessionId, { ip });
      res.setHeader('Set-Cookie', [
        `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        `${CSRF_COOKIE}=; SameSite=Strict; Path=/; Max-Age=0`,
      ]);
      return this.#redirect(res, '/login');
    }

    if (pathname === '/users') {
      const body = await readAndCsrf();
      this.#requirePermission(session, 'user.manage');
      return this.#handleUsersPost(session, body, res);
    }

    if (pathname === '/projects') {
      const body = await readAndCsrf();
      this.#requirePermission(session, 'project.create');
      return this.#handleProjectCreate(session, body, res);
    }

    let m = pathname.match(/^\/projects\/([^/]+)\/deploy$/);
    if (m) {
      await readAndCsrf();
      this.#requirePermission(session, 'project.deploy');
      const id = decodeURIComponent(m[1]);
      await this.#getManager().request('POST', `/projects/${encodeURIComponent(id)}/deploy`, { body: {} });
      return this.#redirect(res, `/projects/${encodeURIComponent(id)}`);
    }

    m = pathname.match(/^\/services\/([^/]+)\/(start|stop|restart|retry)$/);
    if (m) {
      await readAndCsrf();
      this.#requirePermission(session, 'service.start');
      const id = decodeURIComponent(m[1]);
      const act = m[2];
      if (act === 'retry') {
        await this.#getManager().request('POST', '/recovery/retry', { body: { serviceId: id } });
        return this.#redirect(res, '/recovery');
      }
      await this.#getManager().request('POST', `/services/${encodeURIComponent(id)}/${act}`, { body: {} });
      return this.#redirect(res, '/services');
    }

    if (pathname === '/backups') {
      await readAndCsrf();
      this.#requirePermission(session, 'backup.create');
      await this.#getManager().request('POST', '/backups', { body: {} });
      return this.#redirect(res, '/backups');
    }

    return this.#sendError(res, { url: pathname }, 404, NOT_FOUND, 'endpoint tidak ditemukan');
  }

  /** POST /projects → buat project via manager (name/type/port dari form). */
  async #handleProjectCreate(session, body, res) {
    void session;
    const name = String(body.name ?? '').trim();
    const type = String(body.type ?? '').trim();
    const portRaw = String(body.port ?? '').trim();
    const input = { name, type };
    if (portRaw !== '') input.port = Number(portRaw);
    await this.#getManager().request('POST', '/projects', { body: input });
    return this.#redirect(res, '/projects');
  }

  /** /users POST actions (owner only, di-gate user.manage sebelum panggil ini). */
  async #handleUsersPost(session, body, res) {
    const action = String(body.action ?? '').trim();
    const username = String(body.username ?? '').trim();
    const role = String(body.role ?? '').trim();
    const perm = this.#auth.perm;
    let result;
    if (action === 'create-user') {
      result = perm.createUser({ username, role: role === '' ? 'viewer' : role });
    } else if (action === 'approve-user') {
      const target = perm.getUserByUsername(username);
      if (!target) throw new VmPanelError(NOT_FOUND, `user tidak ditemukan: ${username}`);
      result = perm.approveUser(target.userId, session.user.userId);
    } else if (action === 'set-role') {
      const target = perm.getUserByUsername(username);
      if (!target) throw new VmPanelError(NOT_FOUND, `user tidak ditemukan: ${username}`);
      result = perm.setRole(target.userId, role, session.user.userId);
    } else {
      throw new VmPanelError(VALIDATION, `aksi tidak dikenal: ${action}`);
    }
    this.#auditPermissionChange(session, { action, username, role }, result);
    return this.#redirect(res, '/users');
  }

  /** Audit PERMISSION_CHANGE non-fatal (tanpa kredensial — hanya metadata). */
  #auditPermissionChange(session, input, result) {
    if (!this.#auditManager) return;
    try {
      this.#auditManager.append({
        operation: 'PERMISSION_CHANGE',
        actor: session.user.username,
        userId: session.user.userId,
        role: session.user.role,
        input: { ...input, targetUserId: result?.userId },
        result: 'ok',
      });
    } catch {
      /* audit tidak boleh memutus aksi panel */
    }
  }
}


/** CLI entrypoint langsung: `node panel/server/index.js`. */
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { loadConfig } = await import('../../lib/config.js');
  const cfg = loadConfig({ rootDir: process.env.VPANEL_ROOT || process.cwd() });
  const server = new PanelServer({
    rootDir: cfg.rootDir,
    dataDir: join(cfg.rootDir, 'data'),
    config: cfg,
  });
  const addr = await server.start();
  console.log(`[panel] listening on http://127.0.0.1:${addr.port}`);
  const shutdown = async (sig) => {
    console.log(`[panel] ${sig} � shutdown`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
