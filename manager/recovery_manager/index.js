// manager/recovery_manager/index.js — InternalSupervisor (DESIGN.md §8.1-8.3, §8.5).
// Loop per-service interval pollIntervalMs (default 5s): cek PID alive →
// BRANCH ALIVE: health threshold → recovering; BRANCH DEAD: lock per-service →
// restart_policy → backoff eksponensial 5/15/30/60/120s (non-blocking via
// supervisor_state.backoff_until) → restart → health sekali.
// restart_count HANYA di-reset setelah stabil stableWindowMs (600s) — §8.3.
// crash_loop → hentikan auto-retry + alert critical + webhook notifikasi.
//
// Dependency injection: serviceManager / healthManager / processManager.
// serviceManager boleh absen → lazy dynamic import di start() agar modul ini
// tetap loadable meski manager/service_manager belum ada. Semua akses pakai
// optional chaining + normalisasi camelCase/snake_case pada supervisor_state.

import { withLock } from '../../lib/lock.js';
import { LOCK_HELD } from '../../lib/errors.js';

/** Status service yang diawasi supervisor (selain itu: stopped/disabled/archived). */
const ELIGIBLE_STATUS = new Set(['running', 'starting', 'failed']);
/** Health fail berturut-turut sebelum recovering (DESIGN.md §8.1 threshold). */
const HEALTH_FAIL_THRESHOLD = 3;

function errMsg(e) {
  if (e && typeof e.message === 'string' && e.message.length > 0) return e.message;
  return String(e);
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Logger fallback bila tidak diinjeksi (tidak boleh crash supervisor). */
function defaultLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg, extra) => console.warn(`[supervisor] ${msg}`, extra ?? ''),
    error: (msg, extra) => console.error(`[supervisor] ${msg}`, extra ?? ''),
  };
}

/** Baca field supervisor_state, terima camelCase maupun snake_case. */
function stateField(st, camel, snake) {
  if (!st) return undefined;
  const v = st[camel] ?? st[snake];
  return v === undefined ? undefined : v;
}

export class InternalSupervisor {
  /**
   * @param {{
   *   serviceManager?: object, healthManager?: object, processManager?: object,
   *   logger?: {debug,info,warn,error},
   *   pollIntervalMs?: number,      // default 5000 (§8.1); test override kecil
   *   maxRestarts?: number,         // default 5
   *   backoffSeq?: number[],        // detik, default [5,15,30,60,120] (§8.3)
   *   stableWindowMs?: number,      // default 600000 (§8.3 window reset)
   *   notificationWebhook?: string|null,
   *   lockDir?: string, lockWaitMs?: number, lockTtlMs?: number,
   *   nowFn?: () => number,         // injectable clock (epoch ms)
   *   services?: object[],          // inject daftar service statis (opsional)
   * }} opts
   */
  constructor(opts = {}) {
    this.serviceManager = opts.serviceManager ?? null;
    this.healthManager = opts.healthManager ?? null;
    this.processManager = opts.processManager ?? null;
    this.logger = opts.logger ?? defaultLogger();
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.backoffSeq =
      Array.isArray(opts.backoffSeq) && opts.backoffSeq.length > 0
        ? [...opts.backoffSeq]
        : [5, 15, 30, 60, 120];
    this.stableWindowMs = opts.stableWindowMs ?? 600_000;
    this.notificationWebhook = opts.notificationWebhook ?? null;
    this.lockDir = opts.lockDir ?? null;
    this.lockWaitMs = opts.lockWaitMs ?? 2000;
    this.lockTtlMs = opts.lockTtlMs ?? 30_000;
    this._now = typeof opts.nowFn === 'function' ? opts.nowFn : (() => Date.now());
    this._staticServices = Array.isArray(opts.services) ? opts.services : null;

    this.#timer = null;
    this.#ticking = false;
    this.#stopped = false;
    this.#smPromise = null;
  }

  #timer;
  #ticking;
  #stopped;
  #smPromise;

  /* ---------------- lifecycle ---------------- */

  /** Mulai loop. Resolusi serviceManager (injeksi atau lazy import) dulu. */
  async start() {
    if (this.#timer) return;
    await this.#sm(); // gagal → throw sebelum interval jalan
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.logger.info('supervisor.started', { pollIntervalMs: this.pollIntervalMs });
  }

  /** Hentikan loop (clearInterval; tick yang sedang jalan dibiarkan selesai). */
  stop() {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.logger.info('supervisor.stopped', {});
  }

  /** Satu iterasi; guard `ticking` mencegah overlap bila tick lambat. */
  async tick() {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      await this._tickOnce();
    } catch (e) {
      this.logger.error('supervisor.tick.error', { error: errMsg(e) });
    } finally {
      this.#ticking = false;
    }
  }

  /** Reset crash loop secara manual → tick berikutnya langsung mencoba restart. */
  async manualRetry(serviceId) {
    const sm = await this.#sm();
    await sm.setSupervisorState(serviceId, {
      state: 'recovering',
      crashLoop: 0,
      restartCount: 0,
      backoffUntil: null,
      consecutiveFailures: 0,
      lastHealthyAt: null,
    });
    this.logger.info('supervisor.manual_retry', { serviceId });
  }

  /* ---------------- notifikasi (§8.5) ---------------- */

  /**
   * Fire-and-forget POST JSON ke notificationWebhook (timeout 3s, error
   * ditelan). Method publik agar mudah di-mock.
   */
  notify(payload) {
    if (!this.notificationWebhook) return;
    const url = this.notificationWebhook;
    Promise.resolve()
      .then(() =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(3000),
        }),
      )
      .then((res) => {
        if (!res || res.ok !== true) {
          this.logger.warn('supervisor.notify.failed', {
            event: payload?.event,
            status: res?.status ?? null,
          });
        }
      })
      .catch(() => {
        /* fire-and-forget: error jaringan tidak boleh mengganggu supervisor */
      });
  }

  /* ---------------- internal ---------------- */

  /** Resolusi ServiceManager: injeksi > lazy dynamic import. */
  async #sm() {
    if (this.serviceManager) return this.serviceManager;
    if (!this.#smPromise) this.#smPromise = this.#importServiceManager();
    return this.#smPromise;
  }

  async #importServiceManager() {
    const mod = await import('../service_manager/index.js');
    const Ctor = mod?.ServiceManager ?? mod?.default ?? null;
    if (typeof Ctor !== 'function') {
      throw new Error('service_manager belum tersedia (eksport tidak dikenal)');
    }
    const candidates = [
      { healthManager: this.healthManager, processManager: this.processManager, logger: this.logger },
      { logger: this.logger },
      {},
    ];
    let lastErr;
    for (const arg of candidates) {
      try {
        return new Ctor(arg);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('service_manager tidak bisa di-instantiate');
  }

  async _tickOnce() {
    const sm = await this.#sm();
    const list = this._staticServices ?? (await sm.listServices?.()) ?? [];
    for (const row of list) {
      try {
        await this._handleService(sm, row);
      } catch (e) {
        this.logger.error('supervisor.tick.service_error', {
          serviceId: row?.service_id ?? null,
          error: errMsg(e),
        });
      }
    }
  }

  async _handleService(sm, row) {
    const serviceId = row?.service_id;
    if (!serviceId) return;
    const enabled = row.enabled === 1 || row.enabled === true || row.enabled === '1';
    if (!enabled) return;
    if (!ELIGIBLE_STATUS.has(row.status)) return;

    const st = (await sm.getSupervisorState?.(serviceId)) ?? null;
    if (toNum(stateField(st, 'crashLoop', 'crash_loop')) === 1) {
      this.logger.info('supervisor.crash_loop.skip', { serviceId });
      return; // crash loop: hanya manual retry
    }

    const pid = toNum(row.pid);
    const hint = stateField(st, 'startTimeHint', 'start_time_hint') ?? null;
    const pm = this.processManager;
    const alive =
      pid != null && pm && typeof pm.isAlive === 'function'
        ? (await pm.isAlive(pid, hint)) === true
        : false;

    if (alive) {
      await this._handleAlive(sm, row, st);
      return;
    }
    await this._handleDead(sm, row, st);
  }

  /* -------- BRANCH ALIVE: health threshold (§8.1-8.2) -------- */

  async _handleAlive(sm, row, st) {
    const serviceId = row.service_id;
    const res = (await sm.healthService?.(serviceId, this.healthManager)) ?? null;
    const ok = res?.ok === true;
    const failures = this.#consecutiveFailures(res, serviceId);

    if (ok) {
      const curState = stateField(st, 'state', 'state') ?? 'running';
      if (curState === 'recovering') {
        // pulih → kembali running + resolve alert + audit-ish event.
        await sm.setSupervisorState(serviceId, {
          state: 'running',
          consecutiveFailures: 0,
          backoffUntil: null,
          lastHealthyAt: this._now(),
        });
        try {
          await this.healthManager?.resolveAlert?.('SERVICE_UNHEALTHY');
        } catch (e) {
          this.logger.warn('supervisor.alert.resolve_error', { serviceId, error: errMsg(e) });
        }
        this.logger.info('supervisor.service.recovered', {
          serviceId,
          projectId: row.project_id ?? null,
        });
        return;
      }
      // sudah running & sehat: mulai/m pertahankan window stabil (§8.3).
      const now = this._now();
      const lastHealthy = toNum(stateField(st, 'lastHealthyAt', 'last_healthy_at'));
      const restartCount = toNum(stateField(st, 'restartCount', 'restart_count')) ?? 0;
      if (lastHealthy == null) {
        await sm.setSupervisorState(serviceId, { lastHealthyAt: now });
      } else if (now - lastHealthy >= this.stableWindowMs && restartCount > 0) {
        await sm.setSupervisorState(serviceId, { restartCount: 0 });
        this.logger.info('supervisor.stable_window_reset', {
          serviceId,
          restartCount: 0,
          stableMs: now - lastHealthy,
        });
      }
      return;
    }

    // health fail
    await sm.setSupervisorState(serviceId, { consecutiveFailures: failures });
    this.logger.warn('supervisor.health.fail', { serviceId, consecutiveFailures: failures });
    const curState = stateField(st, 'state', 'state') ?? 'running';
    if (failures >= HEALTH_FAIL_THRESHOLD && curState !== 'recovering') {
      await sm.setSupervisorState(serviceId, {
        state: 'recovering',
        consecutiveFailures: failures,
      });
      await this.#raiseAlert({
        projectId: row.project_id ?? null,
        level: 'warning',
        code: 'SERVICE_UNHEALTHY',
        message: `service ${serviceId} unhealthy ${failures}x berturut-turut`,
      });
    }
  }

  /* -------- BRANCH DEAD: policy + backoff + restart (§8.1-8.3) -------- */

  async _handleDead(sm, row, st) {
    const serviceId = row.service_id;
    // (1) event log kematian + exitCode dari process manager (best-effort).
    let exitCode = null;
    try {
      exitCode =
        (typeof this.processManager?.getExitRecord === 'function'
          ? this.processManager.getExitRecord(serviceId)
          : null)?.exitCode ?? null;
    } catch {
      exitCode = null;
    }
    this.logger.warn('supervisor.service.died', {
      serviceId,
      projectId: row.project_id ?? null,
      pid: row.pid ?? null,
      exitCode,
    });

    // (2) lock per-service; gagal (dipegang pihak lain) → skip tick ini.
    let lockHeld = false;
    try {
      await withLock(
        `svc-${serviceId}`,
        { dir: this.lockDir ?? undefined, ttlMs: this.lockTtlMs, maxWaitMs: this.lockWaitMs },
        async () => {
          await this._deadUnderLock(sm, row, st);
        },
      );
    } catch (e) {
      if (e && e.code === LOCK_HELD) {
        lockHeld = true;
        this.logger.warn('supervisor.lock.busy', { serviceId });
      } else {
        this.logger.error('supervisor.lock.error', { serviceId, error: errMsg(e) });
      }
    }
    if (lockHeld) return;
  }

  /** Langkah restart-policy/backoff, dieksekusi DI DALAM lock per-service. */
  async _deadUnderLock(sm, row, stPrev) {
    const serviceId = row.service_id;
    // Re-read di dalam lock: state bisa berubah pihak lain sejak tick mulai.
    const row2 = (await sm.getService?.(serviceId)) ?? row;
    const enabled = row2.enabled === 1 || row2.enabled === true || row2.enabled === '1';
    if (!enabled || !ELIGIBLE_STATUS.has(row2.status)) return;
    const st2 = (await sm.getSupervisorState?.(serviceId)) ?? stPrev ?? null;
    if (toNum(stateField(st2, 'crashLoop', 'crash_loop')) === 1) return;

    const restartCount = toNum(stateField(st2, 'restartCount', 'restart_count')) ?? 0;
    const policy = row2.restart_policy;
    const mode =
      typeof policy === 'string' ? policy : (policy?.mode ?? 'never');

    // (3) policy never → failed + alert, tanpa restart.
    if (mode === 'never') {
      await sm.setSupervisorState(serviceId, {
        state: 'failed',
        status: 'failed',
        backoffUntil: null,
      });
      const prevState = stateField(st2, 'state', 'state');
      if (prevState !== 'failed') {
        this.logger.error('supervisor.service.failed', {
          serviceId,
          projectId: row2.project_id ?? null,
          mode,
        });
        await this.#raiseAlert({
          projectId: row2.project_id ?? null,
          level: 'error',
          code: 'SERVICE_FAILED',
          message: `service ${serviceId} mati; restart_policy=never (manual start diperlukan)`,
        });
      }
      return;
    }

    const now = this._now();
    const backoffUntil = toNum(stateField(st2, 'backoffUntil', 'backoff_until'));

    // (5) restart_count mencapai maxRestarts → crash loop + notifikasi.
    if (restartCount >= this.maxRestarts) {
      await this.#enterCrashLoop(sm, serviceId, row2, restartCount);
      return;
    }

    if (backoffUntil != null && now < backoffUntil) {
      this.logger.debug('supervisor.backoff.waiting', { serviceId, backoffUntil, now });
      return; // masih menunggu backoff — non-blocking
    }

    if (backoffUntil != null && now >= backoffUntil) {
      // backoff selesai → eksekusi restart sekarang.
      await this.#executeRestart(sm, serviceId, row2, restartCount);
      return;
    }

    // Kematian baru: state recovering tanpa backoff (hasil manualRetry) →
    // restart langsung; selain itu jadwalkan backoff pertama (§8.2).
    const curState = stateField(st2, 'state', 'state');
    if (curState === 'recovering') {
      await this.#executeRestart(sm, serviceId, row2, restartCount);
      return;
    }
    const delayMs = this.backoffSeq[Math.min(restartCount, this.backoffSeq.length - 1)] * 1000;
    await sm.setSupervisorState(serviceId, {
      state: 'recovering',
      restartCount,
      backoffUntil: now + delayMs,
    });
    this.logger.warn('supervisor.backoff.scheduled', {
      serviceId,
      projectId: row2.project_id ?? null,
      delayMs,
      restartCount,
      backoffUntil: now + delayMs,
    });
  }

  /** restart → health sekali → sukses (running) / gagal (backoff berikutnya). */
  async #executeRestart(sm, serviceId, row, restartCount) {
    this.logger.info('supervisor.restart.attempt', { serviceId, restartCount });
    let restartOk = false;
    let restartError = null;
    try {
      await sm.restartService(serviceId);
      restartOk = true;
    } catch (e) {
      restartError = errMsg(e);
    }

    let healthOk = false;
    if (restartOk) {
      try {
        const res = (await sm.healthService?.(serviceId, this.healthManager)) ?? null;
        healthOk = res?.ok === true;
      } catch (e) {
        restartError = errMsg(e);
      }
    }

    if (restartOk && healthOk) {
      // Sukses: counter TIDAK direset di sini — hanya setelah window stabil
      // (§8.3). lastHealthyAt = mulai periode stabil baru.
      await sm.setSupervisorState(serviceId, {
        state: 'running',
        status: 'running',
        backoffUntil: null,
        consecutiveFailures: 0,
        lastHealthyAt: this._now(),
      });
      this.logger.info('supervisor.restart.succeeded', {
        serviceId,
        projectId: row.project_id ?? null,
        restartCount,
      });
      return;
    }

    const newCount = restartCount + 1;
    if (newCount >= this.maxRestarts) {
      await sm.setSupervisorState(serviceId, {
        state: 'recovering',
        restartCount: newCount,
        backoffUntil: null,
      });
      await this.#enterCrashLoop(sm, serviceId, row, newCount);
      return;
    }
    const now = this._now();
    const delayMs = this.backoffSeq[Math.min(newCount, this.backoffSeq.length - 1)] * 1000;
    await sm.setSupervisorState(serviceId, {
      state: 'recovering',
      restartCount: newCount,
      backoffUntil: now + delayMs,
    });
    this.logger.warn('supervisor.restart.failed', {
      serviceId,
      projectId: row.project_id ?? null,
      restartCount: newCount,
      delayMs,
      backoffUntil: now + delayMs,
      error: restartError,
    });
  }

  /** crash_loop: stop auto-retry + alert critical + webhook (§8.2, §8.5). */
  async #enterCrashLoop(sm, serviceId, row, restartCount) {
    await sm.setSupervisorState(serviceId, {
      state: 'crash_loop',
      crashLoop: 1,
      status: 'failed',
      restartCount,
      backoffUntil: null,
    });
    this.logger.error('supervisor.crash_loop.detected', {
      serviceId,
      projectId: row.project_id ?? null,
      restartCount,
    });
    await this.#raiseAlert({
      projectId: row.project_id ?? null,
      level: 'critical',
      code: 'CRASH_LOOP',
      message: `service ${serviceId} crash loop (restart_count=${restartCount}); manual retry diperlukan`,
    });
    this.notify({
      event: 'crash_loop',
      serviceId,
      projectId: row.project_id ?? null,
    });
  }

  async #raiseAlert({ projectId, level, code, message }) {
    try {
      await this.healthManager?.raiseAlert?.({ projectId, level, code, message });
    } catch (e) {
      this.logger.error('supervisor.alert.error', { code, error: errMsg(e) });
    }
  }

  /** consecutive_failures dari hasil healthService, fallback health_state. */
  #consecutiveFailures(res, serviceId) {
    let f = toNum(res?.consecutiveFailures ?? res?.consecutive_failures);
    if (f == null) {
      try {
        f = toNum(this.healthManager?.getStatus?.(serviceId)?.consecutive_failures);
      } catch {
        f = null;
      }
    }
    return f ?? 0;
  }
}

export default InternalSupervisor;
