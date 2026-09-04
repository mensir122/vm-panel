// lib/api-client.js — HTTP client Manager API loopback (docs/DESIGN.md §2.3).
// Dipakai vmctl (bin/vmctl.js) dan panel untuk memanggil manager di
// http://127.0.0.1:<port> dengan header Authorization: Bearer <token>.
// Tanpa dependency; fetch bawaan Node >= 20. Error selalu VmPanelError.

import {
  VmPanelError,
  VALIDATION,
  PERMISSION_DENIED,
  NOT_FOUND,
  QUEUE_FULL,
} from './errors.js';

/** Port default manager API (kontrak §2.3; env MANAGER_API_PORT bisa override). */
export const DEFAULT_PORT = 8097;

/** Timeout request default (ms). */
export const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Kode error transport (tidak berasal dari HTTP API — manager mati/timeout):
 * - TIMEOUT     : request melewati timeoutMs (AbortSignal.timeout).
 * - UNREACHABLE : fetch gagal (connection refused / DNS / socket mati).
 */
export const TIMEOUT = 'TIMEOUT';
export const UNREACHABLE = 'UNREACHABLE';

/**
 * Fallback code dari HTTP status bila body tidak membawa error.code.
 * Kontrak §2.3: status 400/403/404/429/500. Status tanpa mapping
 * (mis. 500, 503) memakai code sintetis `HTTP_<status>`.
 */
export const HTTP_STATUS_CODE_MAP = Object.freeze({
  400: VALIDATION,
  403: PERMISSION_DENIED,
  404: NOT_FOUND,
  429: QUEUE_FULL, // rate-limit/queue cap — kode kapasitas terdekat di lib/errors.js
});

/**
 * Client HTTP Manager API.
 * Contoh:
 *   const c = new ManagerClient({ port: 8097, token: 'tok', timeoutMs: 5000 });
 *   const s = await c.systemStatus();
 *   await c.request('POST', '/projects', { body: { name: 'x' } });
 */
export class ManagerClient {
  #port;
  #token;
  #timeoutMs;

  /**
   * @param {object} [opts]
   * @param {number} [opts.port=8097] port manager API (1-65535)
   * @param {string} [opts.token] bearer token; kosong/undefined = tanpa header
   * @param {number} [opts.timeoutMs=10000] timeout per request (ms)
   */
  constructor({ port = DEFAULT_PORT, token = undefined, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new VmPanelError(VALIDATION, `port invalid: ${port}`);
    }
    const t = Number(timeoutMs);
    if (!Number.isFinite(t) || t <= 0) {
      throw new VmPanelError(VALIDATION, `timeoutMs invalid: ${timeoutMs}`);
    }
    this.#port = p;
    this.#token = token;
    this.#timeoutMs = t;
  }

  /**
   * Request JSON ke manager.
   * @param {string} method HTTP method (GET/POST/...)
   * @param {string} path harus diawali '/' (mis. '/system/status')
   * @param {object} [opts] { query: object, body: object }
   * @returns {Promise<any>} parsed JSON body
   * @throws {VmPanelError} TIMEOUT/UNREACHABLE (transport) atau code dari
   *   body.error.code → fallback HTTP_STATUS_CODE_MAP → `HTTP_<status>`.
   *   details berupa { status, message } untuk error HTTP.
   */
  async request(method, path, { query = undefined, body = undefined } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new VmPanelError(VALIDATION, `path harus diawali '/': ${String(path)}`);
    }
    const url = new URL(`http://127.0.0.1:${this.#port}${path}`);
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers = { Accept: 'application/json' };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const name = err && err.name ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new VmPanelError(
          TIMEOUT,
          `manager request timed out after ${this.#timeoutMs}ms (${method} ${path})`,
          { method, path, timeoutMs: this.#timeoutMs },
        );
      }
      throw new VmPanelError(
        UNREACHABLE,
        `cannot reach manager at ${url.origin} (${err && err.message ? err.message : String(err)})`,
        { method, path, reason: err && err.message ? err.message : String(err) },
      );
    }

    if (!res.ok) {
      // Body error kontrak: { error: { code, message } }. Bisa saja bukan JSON.
      let bodyCode;
      let bodyMessage;
      try {
        const parsed = await res.json();
        bodyCode = parsed && parsed.error ? parsed.error.code : undefined;
        bodyMessage = parsed && parsed.error ? parsed.error.message : undefined;
      } catch {
        // body bukan JSON — fallback ke status map
      }
      const code =
        (typeof bodyCode === 'string' && bodyCode) ||
        HTTP_STATUS_CODE_MAP[res.status] ||
        `HTTP_${res.status}`;
      const message = bodyMessage || res.statusText || `HTTP ${res.status}`;
      throw new VmPanelError(code, message, { status: res.status, message });
    }

    try {
      return await res.json();
    } catch {
      throw new VmPanelError(VALIDATION, `manager returned invalid JSON (${method} ${path})`, {
        status: res.status,
      });
    }
  }

  /** GET /system/status → {status, uptimeSec, pid, hostMode, runnerId, startedAt, version} */
  systemStatus() {
    return this.request('GET', '/system/status');
  }

  /** GET /system/info → {name, version, dataDir} */
  systemInfo() {
    return this.request('GET', '/system/info');
  }

  /** GET /health → {ok:true} */
  health() {
    return this.request('GET', '/health');
  }

  /** GET /projects → array project */
  listProjects() {
    return this.request('GET', '/projects');
  }

  /** GET /audit?limit&offset&actor&operation&projectId → {rows, total} */
  listAudit(query = {}) {
    return this.request('GET', '/audit', { query });
  }
}
