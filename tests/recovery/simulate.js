#!/usr/bin/env node
// tests/recovery/simulate.js — Failure Simulation Harness (DESIGN.md §19.3).
//
// Runner CLI: node tests/recovery/simulate.js [--only 5,19] [--report path]
//   - setiap skenario print [PASS]/[FAIL] + detail;
//   - laporan markdown di-APPEND ke docs/test-report.md (section
//     "Failure Simulation Run <timestamp UTC>", tabel hasil; file dibuat bila
//     belum ada);
//   - exit 0 bila semua skenario PASS, 1 bila ada FAIL, 2 bila argumen salah.
//
// Cakupan (F5 Wave 1): skenario yang BELUM tercover unit test. Skenario 1-4
// (internal-supervisor.test.js + health-manager.test.js), 8-11 (db.test.js +
// backup-restore.test.js), 13-17 (backup-restore/deployment/export-import),
// 18 (deployment.test.js) TIDAK diduplikasi. Skenario 7/12/22 butuh GitHub
// Actions nyata (live chain drill) — di luar scope harness lokal.
//
//   5  Manager mati (SIGKILL) → external watchdog (pid file, max 3/menit)
//      → manager naik lagi → /health 200 → state DB utuh.
//   6  Panel mati (SIGKILL) → external watchdog → panel naik lagi → state utuh.
//   19 Manager mati DI TENGAH restore (fault injection 2 titik: setelah marker,
//      mid-swap) → restore ulang idempotent via pre-restore marker.
//   20 Supervisor mati mid-recovery (stop() di antara backoff) → supervisor
//      baru dengan state sama → lanjut konsisten (recovered/crash_loop).
//   21 Backup vs deployment konkuren → tidak deadlock (guard 60s), keduanya
//      sukses ATAU yang kalah gagal bersih dengan error code benar.
//   23 Split-brain: dua chain leader (dua proses) rebutan runner.lock TTL
//      via lib/lock.js → tepat satu winner; acquireAll leksikografis.
//   24 Port leak & rekonsiliasi: kill child manual → release-on-exit wiring;
//      orphan row (simulasi crash drift) → rekonsiliasi bind-test membersihkan.
//
// Verification requirements §19.2 di-assert per skenario: event/error tercatat,
// retry dibatasi, data valid terakhir tetap ada, tidak ada data valid terhapus.
// Deterministik di Windows: kill via process.kill(pid) — TANPA shell.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { openDatabase } from '../../lib/db.js';
import { acquire, release, acquireAll, releaseAll } from '../../lib/lock.js';
import { BackupManager } from '../../manager/backup_manager/index.js';
import { RestoreManager } from '../../manager/restore_manager/index.js';
import { InternalSupervisor } from '../../manager/recovery_manager/index.js';
import { ProcessManager } from '../../manager/process_manager/index.js';
import { ProjectManager } from '../../manager/project_manager/index.js';
import { ServiceManager } from '../../manager/service_manager/index.js';
import { HealthManager } from '../../manager/health_manager/index.js';
import { DeploymentManager } from '../../manager/deployment_manager/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ID = 'prj_S1MAAAAAAA'; // 10 char Crockford base32 (tanpa I/L/O/U)

/* ------------------------------------------------------------------ */
/* util                                                                */
/* ------------------------------------------------------------------ */

function ts() {
  return new Date().toISOString();
}

function errMsg(e) {
  return e && typeof e.message === 'string' && e.message.length > 0 ? e.message : String(e);
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** rmSync dengan retry — AV/indexer Windows sesekali mengunci path tmp. */
function rmWithRetry(p, attempts = 6) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return true;
    } catch (e) {
      lastErr = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
    }
  }
  console.warn(`[simulate] cleanup tmp gagal (dibiarkan): ${p} — ${errMsg(lastErr)}`);
  return false;
}

/** Spawn node child (NO SHELL) dengan stdio ke file log di sandbox. */
function spawnNode({ argv, cwd, outPath, env = {} }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.openSync(outPath, 'a');
  const child = spawn(process.execPath, argv, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
    windowsHide: true,
    shell: false,
  });
  fs.closeSync(out);
  return child;
}

/** Poll predikat async sampai true / timeout. */
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = (await fn()) === true;
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await delay(stepMs);
  }
}

/** Poll fetch URL (dengan optional headers) sampai predikat status terpenuhi. */
async function waitForHttp(url, timeoutMs = 15_000, pred = (r) => r.status === 200, headers = {}) {
  return waitFor(async () => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      await res.text().catch(() => {});
      return pred(res) === true;
    } catch {
      return false;
    }
  }, timeoutMs, 200);
}

/** GET API manager (bearer); throw bila !ok. */
async function apiGet(port, token, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`API ${pathname} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/** Import specifier file:// dari path absolut (Windows-safe untuk child script). */
function modUrl(p) {
  return JSON.stringify(pathToFileURL(p).href);
}

/** Port bebas 20000-29999 via bind test (net, tanpa ProcessManager). */
async function pickFreePort() {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    // eslint-disable-next-line no-await-in-loop
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => {
        try { srv.close(); } catch { /* noop */ }
        resolve(false);
      });
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(true));
      });
    });
    if (free) return port;
  }
  throw new Error('tidak ada port bebas ditemukan');
}

function readTail(p, n = 2500) {
  try {
    return fs.readFileSync(p, 'utf8').slice(-n);
  } catch {
    return '(log tidak tersedia)';
  }
}

/* ------------------------------------------------------------------ */
/* assertion helper skenario                                           */
/* ------------------------------------------------------------------ */

export class ScenarioError extends Error {}

export function assert(cond, msg) {
  if (!cond) throw new ScenarioError(msg);
}

/** Baca row manager pid file (runtime/pid/manager.pid), null bila tidak ada. */
function readPidFile(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // EPERM = hidup tanpa izin signal
  }
}

/** Tunggu proses mati setelah SIGKILL (ESRCH). */
async function waitDead(pid, timeoutMs = 10_000) {
  return waitFor(async () => !isAlive(pid), timeoutMs, 100);
}

/* ------------------------------------------------------------------ */
/* Skenario 5 — Manager mati + external watchdog restart (§8.4)        */
/* ------------------------------------------------------------------ */

async function scenario5ManagerDeath(ctx) {
  const { rootDir, dataDir } = ctx;
  fs.mkdirSync(path.join(rootDir, 'runtime', 'pid'), { recursive: true });

  // State DB utuh: seed row platform meta SEBELUM manager start.
  const seeded = openDatabase(path.join(dataDir, 'platform.db'), { schemaName: 'platform' });
  seeded.migrate();
  seeded.setMeta('sim_state_row', 'pre-kill-value-1');
  seeded.close();

  // Manager nyata (CLI entry manager/index.js) di sandbox, port+token fixed.
  const apiPort = await pickFreePort();
  const token = `sim-token-${Date.now().toString(36)}`;
  const pidFile = path.join(rootDir, 'runtime', 'pid', 'manager.pid');
  const managerEnv = {
    VPANEL_ROOT: rootDir,
    MANAGER_API_PORT: String(apiPort),
    MANAGER_API_TOKEN: token,
  };
  const logPath = path.join(rootDir, 'sandbox-out', 'manager.log');
  const spawnManager = () =>
    spawnNode({ argv: [path.join(ROOT, 'manager', 'index.js')], cwd: rootDir, outPath: logPath, env: managerEnv });

  let mgr = spawnManager();
  ctx.trackCleanup(() => {
    watchdogStopRef?.();
    killPid(mgr.pid);
    killPid(readPidFile(pidFile)); // manager mana pun yang hidup via pid file
  });
  let watchdogStopRef = null;

  // /health ok (bearer) + pid file tertulis.
  assert(
    await waitForHttp(`http://127.0.0.1:${apiPort}/health`, 30_000, (r) => r.status === 200, {
      authorization: `Bearer ${token}`,
    }),
    `manager /health tidak 200 sebelum kill. log: ${readTail(logPath)}`,
  );
  assert(
    await waitFor(() => readPidFile(pidFile) === mgr.pid, 10_000, 150),
    'pid file manager harus berisi pid child',
  );

  const statusBefore = await apiGet(apiPort, token, '/system/status');
  assert(statusBefore.status === 'running', 'status manager sebelum kill harus running');

  // === Kill -SIGKILL (process.kill, bukan shell) ===
  process.kill(mgr.pid, 'SIGKILL');
  assert(await waitDead(mgr.pid), 'manager child tidak mati setelah SIGKILL');

  // === External watchdog layer: monitor pid file, restart max 3/menit ===
  const watchdog = createWatchdog({
    pidFile,
    spawn: spawnManager,
    maxRestartsPerMinute: 3,
    logFile: path.join(rootDir, 'logs', 'recovery', 'watchdog.log'),
  });
  watchdogStopRef = () => watchdog.stop();
  ctx.trackCleanup(() => watchdog.stop());
  await watchdog.ensureRunning({ timeoutMs: 30_000 });

  // Manager naik lagi → /health ok.
  assert(
    await waitForHttp(`http://127.0.0.1:${apiPort}/health`, 20_000, (r) => r.status === 200, {
      authorization: `Bearer ${token}`,
    }),
    `manager /health tidak 200 setelah watchdog restart. log: ${readTail(logPath)}`,
  );

  // §19.2: deteksi tercatat — watchdog restart event di logs/recovery/watchdog.log.
  const wdLogPath = path.join(rootDir, 'logs', 'recovery', 'watchdog.log');
  assertFileExists(wdLogPath, 'logs/recovery/watchdog.log harus ada');
  const wdLog = fs.readFileSync(wdLogPath, 'utf8');
  assert(wdLog.includes('"event":"restart"'), 'event restart watchdog harus tercatat');
  assert(watchdog.restartsUsed() <= 3, 'retry watchdog dibatasi max 3/menit');

  // State DB utuh: row yang dibuat sebelum kill masih ada.
  const after = openDatabase(path.join(dataDir, 'platform.db'), { schemaName: 'platform' });
  const row = after.getMeta('sim_state_row');
  after.close();
  assert(row === 'pre-kill-value-1', `row platform meta dari sebelum kill harus utuh (dapat: ${row})`);

  watchdog.stop();
  killPid(mgr.pid);
  return 'SIGKILL → watchdog restart (≤3/menit, event tercatat) → /health 200 → row platform pre-kill utuh';
}

function assertFileExists(p, msg) {
  assert(fs.existsSync(p), `${msg} (file tidak ada: ${p})`);
}

function killPid(pid) {
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* sudah mati */
    }
  }
}

/** External watchdog sederhana (pola §8.4 workflow step): poll pid file;
 *  mati/stale → spawn ulang; rate limit restart max N per menit. Track SEMUA
 *  child yang di-spawn — stop() mengkill semuanya (tidak ada proses yatim). */
export function createWatchdog({ pidFile, spawn, maxRestartsPerMinute = 3, logFile }) {
  const state = { stopped: false, restarts: [], children: [] };

  function log(event, extra = {}) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${JSON.stringify({ ts: ts(), event, ...extra })}\n`);
    } catch {
      /* best-effort */
    }
  }

  async function ensureRunning({ timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (state.stopped) throw new ScenarioError('watchdog sudah dihentikan');
      const pid = readPidFile(pidFile);
      if (isAlive(pid)) return true;

      const now = Date.now();
      state.restarts = state.restarts.filter((t) => now - t < 60_000);
      if (state.restarts.length >= maxRestartsPerMinute) {
        if (Date.now() > deadline) {
          throw new ScenarioError('watchdog: restart limit tercapai sebelum proses hidup lagi');
        }
        await delay(200);
        continue;
      }
      killPid(pid); // pid yatim/stale dari pid file (best-effort)
      try {
        fs.unlinkSync(pidFile); // pid file stale dari proses mati
      } catch {
        /* tidak ada */
      }
      const child = spawn();
      state.children.push(child);
      state.restarts.push(now);
      log('restart', { attempt: state.restarts.length, pid: child.pid });
      // Tunggu child ini menulis pid file (bukti hidup & siap).
      const took = await waitFor(() => readPidFile(pidFile) === child.pid, 12_000, 100);
      if (took && isAlive(child.pid)) return true;
      killPid(child.pid); // gagal start → bersihkan sebelum attempt berikutnya
      if (Date.now() > deadline) {
        throw new ScenarioError('watchdog: timeout menunggu proses hidup lagi');
      }
    }
  }

  return {
    ensureRunning,
    restartsUsed: () => state.restarts.length,
    stop() {
      state.stopped = true;
      for (const c of state.children) killPid(c.pid);
      killPid(readPidFile(pidFile)); // pemilik pid file aktif (bila beda child)
    },
  };
}

/* ------------------------------------------------------------------ */
/* Skenario 6 — Panel mati + external watchdog restart                 */
/* ------------------------------------------------------------------ */

async function scenario6PanelDeath(ctx) {
  const { rootDir } = ctx;
  const panelDataDir = path.join(rootDir, 'panel-data');
  fs.mkdirSync(panelDataDir, { recursive: true });

  // Panel nyata (PanelServer asli) sebagai child process, port ephemeral.
  const panelEntry = path.join(rootDir, 'panel-child.mjs');
  const infoPath = path.join(rootDir, 'panel-info.json');
  fs.writeFileSync(
    panelEntry,
    [
      `import { PanelServer } from ${modUrl(path.join(ROOT, 'panel', 'server', 'index.js'))};`,
      `import fs from 'node:fs';`,
      `import path from 'node:path';`,
      `import { fileURLToPath } from 'node:url';`,
      `const dir = path.dirname(fileURLToPath(import.meta.url));`,
      `const dataDir = ${JSON.stringify(panelDataDir)};`,
      `const server = new PanelServer({ rootDir: dir, dataDir, config: { panel: { port: 0 } } });`,
      `const addr = await server.start();`,
      `fs.writeFileSync(${JSON.stringify(infoPath)}, JSON.stringify({ pid: process.pid, port: addr.port }));`,
      `const shutdown = () => process.exit(0);`,
      `process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);`,
      '',
    ].join('\n'),
  );
  const logPath = path.join(rootDir, 'sandbox-out', 'panel.log');
  const spawnPanel = () => spawnNode({ argv: [panelEntry], cwd: rootDir, outPath: logPath });

  // Track semua child panel — kill semuanya di akhir (tidak ada proses yatim).
  const children = [];
  const spawnTracked = () => {
    const c = spawnPanel();
    children.push(c);
    return c;
  };
  const killAllPanelChildren = () => {
    for (const c of children) killPid(c.pid);
  };
  ctx.trackCleanup(killAllPanelChildren);

  /** Baca panel-info.json yang ditulis child dengan pid tertentu. */
  const readInfoFor = (childPid) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      return parsed && parsed.pid === childPid && Number.isInteger(parsed.port) ? parsed : null;
    } catch {
      return null;
    }
  };

  let panel = spawnTracked();
  assert(
    await waitFor(() => readInfoFor(panel.pid) !== null, 20_000, 100),
    `panel child tidak menulis panel-info.json (start gagal?). log: ${readTail(logPath)}`,
  );
  const info1 = readInfoFor(panel.pid);

  assert(
    await waitForHttp(`http://127.0.0.1:${info1.port}/login`, 10_000),
    `panel /login tidak 200 sebelum kill. log: ${readTail(logPath)}`,
  );

  // State valid terakhir: users.db ada & bootstrapped owner tercatat sebelum kill.
  const { PermissionManager } = await import(pathToFileURL(path.join(ROOT, 'manager', 'permission_manager', 'index.js')).href);
  const perm1 = new PermissionManager({ dataDir: panelDataDir });
  perm1.ensureOwnerBootstrap({ username: 'harness-owner' });
  const ownerBefore = perm1.getUserByUsername('harness-owner');
  perm1.close();
  assert(ownerBefore && ownerBefore.userId, 'owner bootstrap harus tercatat di users.db');

  // === Kill panel (SIGKILL) ===
  process.kill(info1.pid, 'SIGKILL');
  assert(await waitDead(info1.pid), 'panel child tidak mati setelah SIGKILL');

  // === External watchdog: pid mati → spawn ulang, max 3/menit, event tercatat ===
  const wdLogFile = path.join(rootDir, 'logs', 'recovery', 'watchdog-panel.log');
  const restarts = [];
  const deadline = Date.now() + 40_000;
  let info2 = null;
  while (info2 === null) {
    assert(Date.now() <= deadline, 'watchdog panel: timeout menunggu restart');
    const now = Date.now();
    while (restarts.length > 0 && now - restarts[0] >= 60_000) restarts.shift();
    assert(restarts.length < 3, 'watchdog panel: restart limit tercapai sebelum panel hidup lagi');
    try {
      fs.writeFileSync(infoPath, ''); // invalidasi info lama
    } catch {
      /* best-effort */
    }
    const child = spawnTracked();
    restarts.push(now);
    try {
      fs.mkdirSync(path.dirname(wdLogFile), { recursive: true });
      fs.appendFileSync(
        wdLogFile,
        `${JSON.stringify({ ts: ts(), event: 'restart', attempt: restarts.length, pid: child.pid })}\n`,
      );
    } catch {
      /* best-effort */
    }
    // NB: waitFor mengharuskan fn() === true; readInfoFor mengembalikan objek
    // → bungkus: sukses bila info valid DAN pid beda dari victim & masih hidup.
    const got = await waitFor(() => {
      const info = readInfoFor(child.pid);
      return info && info.pid === child.pid && isAlive(child.pid) ? true : false;
    }, 12_000, 100);
    if (got) {
      info2 = readInfoFor(child.pid);
      break;
    }
    killPid(child.pid); // gagal start → bersihkan sebelum attempt berikutnya
  }

  // Panel naik lagi: /login 200.
  assert(
    await waitForHttp(`http://127.0.0.1:${info2.port}/login`, 15_000),
    `panel /login tidak 200 setelah restart. log: ${readTail(logPath)}`,
  );

  // State utuh: owner row dari sebelum kill masih ada di users.db.
  const perm2 = new PermissionManager({ dataDir: panelDataDir });
  const ownerAfter = perm2.getUserByUsername('harness-owner');
  perm2.close();
  assert(ownerAfter && ownerAfter.userId === ownerBefore.userId, 'owner users.db harus utuh setelah restart');

  // §19.2: event watchdog tercatat + retry dibatasi.
  assertFileExists(wdLogFile, 'watchdog-panel.log harus ada');
  const wdLog = fs.readFileSync(wdLogFile, 'utf8');
  assert(wdLog.includes('"event":"restart"'), 'event restart watchdog panel harus tercatat');
  assert(restarts.length <= 3, 'retry watchdog panel dibatasi max 3/menit');

  killAllPanelChildren(); // tidak ada proses yatim
  return `SIGKILL → watchdog restart (port ${info1.port} → ${info2.port}, event tercatat) → /login 200 → owner users.db utuh`;
}

/* ------------------------------------------------------------------ */
/* Skenario 19 — Manager mati DI TENGAH restore → restore ulang        */
/* ------------------------------------------------------------------ */

async function scenario19RestoreCrash(ctx) {
  const { dataDir, backupsRoot, lockDir, rootDir } = ctx;
  const rig = makeRestoreRig(ctx);
  const first = rig.mk();
  const bm = first.bm;

  // Backup awal (snapshot = data valid terakhir).
  const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
  assert(res.verification.ok === true, `backup awal harus valid: ${res.verification.error}`);
  const backupId = res.backupId;

  // Mutasi data SETELAH backup (harus hilang kembali setelah restore).
  const projects = openDatabase(path.join(dataDir, 'projects.db'), { schemaName: 'projects' });
  projects.db
    .prepare(
      `INSERT INTO projects (id, name, type, status, created_at)
       VALUES ('prj_TESTZZZ9', 'app-after-backup', 'static', 'running', '2026-05-01T00:00:00Z')`,
    )
    .run();
  projects.close();
  assert(projectsCount(dataDir) === 2, 'setup: 2 row projects');

  // Tutup handle katalog — child akan memakai dataDir yang sama (Windows EBUSY).
  bm.close();

  // === Fault injection: restore di child process, SIGKILL DI TENGAH operasi ===
  const abortFile = path.join(dataDir, '.sim-abort-after');
  const childScript = path.join(rootDir, 'restore-child.mjs');
  fs.writeFileSync(
    childScript,
    [
      `import fs from 'node:fs';`,
      `import path from 'node:path';`,
      `const { BackupManager } = await import(${modUrl(path.join(ROOT, 'manager', 'backup_manager', 'index.js'))});`,
      `const { RestoreManager } = await import(${modUrl(path.join(ROOT, 'manager', 'restore_manager', 'index.js'))});`,
      `const dataDir = ${JSON.stringify(dataDir)};`,
      `const stage = process.argv[2];`,
      `const bm = new BackupManager({ dataDir, backupsRoot: ${JSON.stringify(backupsRoot)}, lockDir: ${JSON.stringify(lockDir)} });`,
      `const rm = new RestoreManager({ dataDir, backupsRoot: ${JSON.stringify(backupsRoot)}, backupManager: bm });`,
      `if (stage === 'marker') {`,
      `  // Mati TEPAT setelah pre-restore marker ditulis (sebelum ekstraksi selesai).`,
      `  const origWrite = rm._writeMarker.bind(rm);`,
      `  rm._writeMarker = (p, o) => {`,
      `    origWrite(p, o);`,
      `    fs.writeFileSync(${JSON.stringify(abortFile)}, 'marker');`,
      `    process.kill(process.pid, 'SIGKILL');`,
      `  };`,
      `} else {`,
      `  // Mati DI TENGAH atomic swap: tepat setelah rename rollback point pertama.`,
      `  const origRename = fs.renameSync.bind(fs);`,
      `  fs.renameSync = (a, b) => {`,
      `    origRename(a, b);`,
      `    if (b.includes('.pre-restore-')) {`,
      `      fs.writeFileSync(${JSON.stringify(abortFile)}, 'midswap');`,
      `      process.kill(process.pid, 'SIGKILL');`,
      `    }`,
      `  };`,
      `}`,
      `rm.restoreBackup(${JSON.stringify(backupId)}, { dryRun: false });`,
      `console.error('CHILD-NOT-KILLED'); process.exit(2);`,
      '',
    ].join('\n'),
  );
  const childLog = path.join(rootDir, 'sandbox-out', 'restore-child.log');
  const runChild = (stage) =>
    new Promise((resolvePromise) => {
      const child = spawnNode({ argv: [childScript, stage], cwd: rootDir, outPath: childLog });
      const killer = setTimeout(() => killPid(child.pid), 20_000);
      child.once('exit', (code, signal) => {
        clearTimeout(killer);
        resolvePromise({ code, signal });
      });
    });

  // Fase A: mati tepat setelah marker ditulis → marker + staging tertinggal.
  try { fs.unlinkSync(abortFile); } catch { /* tidak ada */ }
  await runChild('marker');
  assert(fs.existsSync(abortFile), 'fase A: fault injection abort file harus tertulis (child mati di hook)');
  assertFileExists(path.join(dataDir, '.restore-marker.json'), 'pre-restore marker harus tertinggal (crash di tengah restore)');
  assert(projectsCount(dataDir) === 2, 'fase A: data belum di-restore (row mutasi masih ada)');

  // Fase B: mati DI TENGAH swap → rollback point parsial + marker token baru.
  try { fs.unlinkSync(abortFile); } catch { /* tidak ada */ }
  await runChild('midswap');
  assert(fs.existsSync(abortFile), 'fase B: fault injection mid-swap tidak terjadi');
  assertFileExists(path.join(dataDir, '.restore-marker.json'), 'fase B: marker token kedua harus tertinggal');

  // === Restore ulang (manager baru) → harus idempotent & berhasil ===
  const second = rig.mk();
  const report = second.rm.restoreBackup(backupId, { dryRun: false });
  assert(report.dryRun === false, 'restore ulang harus dryRun=false');
  assert(report.restored.includes('platform'), 'platform harus ter-restore ulang');
  assert(report.restored.includes('projects'), 'projects harus ter-restore ulang');
  assert(
    report.warnings.some((w) => /marker dari run sebelumnya/.test(w)),
    `restore ulang harus mendeteksi+membersihkan marker run terputus (warnings: ${JSON.stringify(report.warnings)})`,
  );

  // §19.2: data valid terakhir kembali utuh; marker dibersihkan; staging bersih.
  assert(projectsCount(dataDir) === 1, 'restore ulang harus mengembalikan snapshot (1 row projects)');
  assert(!fs.existsSync(path.join(dataDir, '.restore-marker.json')), 'marker harus dihapus setelah restore sukses');
  const stagingLeft = fs.readdirSync(dataDir).filter((f) => f.startsWith('.restore-staging-'));
  assert(stagingLeft.length === 0, `staging lama harus dibersihkan (sisa: ${stagingLeft.join(',')})`);

  // Integrity + rollback point terakhir + backup asli tidak tersentuh.
  const plat = openDatabase(path.join(dataDir, 'platform.db'), { schemaName: 'platform' });
  assert(plat.integrityCheck().ok === true, 'platform.db hasil restore integrity ok');
  plat.close();
  const rollbackDirs = fs.readdirSync(dataDir).filter((f) => f.startsWith('.restore-rollback-'));
  assert(rollbackDirs.length >= 1, 'rollback point hasil restore sukses harus ada (anti-destruktif)');
  const manifest = JSON.parse(fs.readFileSync(path.join(backupsRoot, 'manual', backupId, 'manifest.json'), 'utf8'));
  const zlib = await import('node:zlib');
  const crypto = await import('node:crypto');
  for (const f of manifest.files) {
    const abs = path.join(backupsRoot, 'manual', backupId, ...f.relPath.split('/'));
    const raw = zlib.gunzipSync(fs.readFileSync(abs));
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    assert(sha === f.sha256, `snapshot asli tidak boleh tersentuh: ${f.relPath}`);
  }

  second.bm.close();
  return '2x crash mid-restore (marker & mid-swap) → restore ulang deteksi marker → idempotent sukses → snapshot utuh, marker+staging bersih, snapshot asli tak tersentuh';
}

function projectsCount(dataDir) {
  const h = openDatabase(path.join(dataDir, 'projects.db'), { schemaName: 'projects' });
  try {
    return h.db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  } finally {
    h.close();
  }
}

/* ------------------------------------------------------------------ */
/* Skenario 20 — Supervisor mati mid-recovery → supervisor baru        */
/* ------------------------------------------------------------------ */

/** FAKE ServiceManager in-memory (pola tests/unit/internal-supervisor.test.js). */
class FakeServiceManager {
  constructor() {
    this.services = new Map();
    this.supState = new Map();
    this.restartCalls = [];
    this.healthCalls = [];
    this.restartImpl = null;
    this.healthImpl = null;
  }
  addService(row) {
    this.services.set(row.service_id, {
      service_id: row.service_id,
      project_id: 'prj_S1MAAAAAA',
      status: 'running',
      pid: 111_111,
      enabled: 1,
      config: {},
      restart_policy: { mode: 'on-failure' },
      ...row,
    });
  }
  listServices() {
    return [...this.services.values()];
  }
  getService(id) {
    return this.services.get(id) ?? null;
  }
  async restartService(id) {
    this.restartCalls.push({ id });
    if (this.restartImpl) return this.restartImpl(id);
    return { pid: 9000 + this.restartCalls.length };
  }
  setSupervisorState(id, patch) {
    const next = { ...(this.supState.get(id) ?? {}), ...patch };
    this.supState.set(id, next);
    return next;
  }
  getSupervisorState(id) {
    return this.supState.get(id) ?? null;
  }
  async healthService(id) {
    this.healthCalls.push({ id });
    if (this.healthImpl) return this.healthImpl(id);
    return { ok: true, consecutiveFailures: 0 };
  }
}

class FakeProcessManager {
  constructor() {
    this.aliveImpl = () => false;
  }
  async isAlive() {
    return this.aliveImpl() === true;
  }
  getExitRecord() {
    return null;
  }
}

function captureLogger(nowFn) {
  const events = [];
  const mk = (level) => (msg, extra) => events.push({ level, msg, extra: extra ?? null, at: nowFn() });
  return {
    events,
    logger: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') },
  };
}

async function scenario20SupervisorMidRecovery(ctx) {
  let nowMs = 1_700_000_000_000;
  const health = new HealthManager({ dataDir: mkdtemp('vmpanel-sim-h-') });
  ctx.trackCleanup(() => health.close());

  const sm = new FakeServiceManager();
  const pm = new FakeProcessManager();
  pm.aliveImpl = () => false; // program service dead
  sm.addService({ service_id: 'svc-20', pid: 111_111, status: 'running' });

  const mkSup = () => {
    const { events, logger } = captureLogger(() => nowMs);
    const sup = new InternalSupervisor({
      serviceManager: sm,
      healthManager: health,
      processManager: pm,
      logger,
      nowFn: () => nowMs,
      lockDir: ctx.lockDir,
      lockWaitMs: 50,
      lockTtlMs: 5000,
      pollIntervalMs: 15,
      maxRestarts: 5,
    });
    return { sup, events };
  };

  // Supervisor #1: deteksi mati → backoff → restart sukses.
  const { sup: sup1, events: events1 } = mkSup();
  await sup1.tick();
  let st = sm.getSupervisorState('svc-20');
  assert(st.state === 'recovering' && st.backoffUntil === nowMs + 5000, 'tick 1: backoff 5s terjadwal (event §19.2)');
  assert(events1.some((e) => e.msg === 'supervisor.service.died'), 'event service.died tercatat');
  assert(events1.some((e) => e.msg === 'supervisor.backoff.scheduled'), 'event backoff.scheduled tercatat');

  nowMs += 5001;
  await sup1.tick(); // restart diproses → sukses → running
  st = sm.getSupervisorState('svc-20');
  assert(st.state === 'running' && sm.restartCalls.length === 1, 'tick 2: restart sukses');

  // === Manager "mati" mid-recovery: service mati lagi → backoff dijadwalkan →
  // stop() DI ANTARA backoff (loop tidak pernah mengeksekusi restart). ===
  sm.services.get('svc-20').status = 'failed';
  sm.restartImpl = async () => {
    throw new Error('spawn gagal');
  };
  nowMs += 1000;
  await sup1.tick(); // deteksi mati kedua → jadwalkan backoff index 0 (5s)
  st = sm.getSupervisorState('svc-20');
  assert(
    st.state === 'recovering' && st.backoffUntil === nowMs + 5000 && (st.restartCount ?? 0) === 0,
    'kematian kedua: backoff 5s terjadwal tanpa restart',
  );

  sup1.stop(); // supervisor mati mid-flight (di antara backoff)

  // Supervisor BARU dengan state DB yang sama (restore manager §8.6) → lanjut.
  const { sup: sup2, events: events2 } = mkSup();
  nowMs += 5001;
  await sup2.tick(); // backoff lewat → attempt gagal → rc=1 → backoff 15s
  st = sm.getSupervisorState('svc-20');
  assert(st.restartCount === 1, 'supervisor baru melanjutkan counter (rc=1, tidak di-reset)');
  assert(st.backoffUntil === nowMs + 15_000, 'backoff berikutnya 15s (urutan eksponensial konsisten)');
  assert(events2.some((e) => e.msg === 'supervisor.restart.failed'), 'event restart.failed (supervisor baru) tercatat');

  nowMs += 15_001;
  await sup2.tick(); // attempt 2 gagal → rc=2 → backoff 30s
  st = sm.getSupervisorState('svc-20');
  assert(st.restartCount === 2 && st.backoffUntil === nowMs + 30_000, 'rc=2 + backoff 30s');

  // Retry dibatasi (§19.2): counter naik 1 per attempt; manualRetry → recovered.
  await sup2.manualRetry('svc-20');
  sm.restartImpl = async () => ({ pid: 4242 });
  await sup2.tick();
  st = sm.getSupervisorState('svc-20');
  assert(st.state === 'running' && (st.crashLoop ?? 0) !== 1, 'hasil akhir konsisten: recovered (running, tanpa crash loop)');
  assert(st.restartCount === 0, 'manualRetry mereset counter ke 0 (jalur manual)');
  assert(sm.restartCalls.length === 4, `retry dibatasi: tepat 4 attempt (1 sukses awal + 2 gagal + 1 manual), dapat: ${sm.restartCalls.length}`);
  assert(events2.some((e) => e.msg === 'supervisor.restart.succeeded'), 'event restart.succeeded tercatat');
  assert(events1.some((e) => e.msg === 'supervisor.stopped'), 'stop() supervisor 1 tercatat (mid-flight)');

  sup2.stop();
  sup1.stop();
  return 'stop() di antara backoff → supervisor baru (state sama) lanjut: rc 0→1→2, backoff 15s/30s konsisten → manualRetry → recovered (3 attempt, dibatasi)';
}

/* ------------------------------------------------------------------ */
/* Skenario 21 — Backup vs deployment konkuren (tidak deadlock)        */
/* ------------------------------------------------------------------ */

async function scenario21BackupVsDeploy(ctx) {
  const rig = makeDepRig(ctx);
  ctx.trackCleanup(() => rig.close());

  const GUARD_MS = 60_000; // timeout guard §19.1 skenario 21

  // createBackup (manual — bebas rate-limit) mulai duluan, mengambil lock global.
  let backupErr = null;
  let backupRes = null;
  const backupP = rig.bm
    .createBackup({ trigger: 'manual', retentionClass: 'manual' })
    .then((r) => {
      backupRes = r;
      return r;
    })
    .catch((e) => {
      backupErr = e;
      return null;
    });

  // Bersamaan (hampir): deploy project (workspace source, adapter static).
  await delay(50);
  let deployErr = null;
  let deployRes = null;
  const deployP = rig
    .deploy()
    .then((r) => {
      deployRes = r;
      return r;
    })
    .catch((e) => {
      deployErr = e;
      return null;
    });

  // TIDAK deadlock: keduanya selesai dalam guard 60s.
  const outcome = await Promise.race([
    Promise.all([backupP, deployP]).then(() => 'both'),
    delay(GUARD_MS).then(() => 'timeout'),
  ]);
  assert(outcome !== 'timeout', 'backup+deploy konkuren tidak selesai dalam 60s — deadlock');
  await backupP;
  await deployP;

  // Hasil: keduanya sukses ATAU yang kalah gagal bersih dengan error code benar.
  const backupOk = backupRes != null;
  const deployOk = deployRes != null;
  assert(backupOk || deployOk, 'minimal satu operasi harus sukses');
  if (!backupOk) {
    assert(
      ['BACKUP_IN_PROGRESS', 'LOCK_HELD', 'VALIDATION'].includes(backupErr?.code),
      `backup gagal harus dengan code bersih, dapat: ${backupErr?.code} (${errMsg(backupErr)})`,
    );
  }
  if (!deployOk) {
    assert(
      ['DEPLOY_IN_PROGRESS', 'LOCK_HELD', 'VALIDATION', 'NOT_FOUND'].includes(deployErr?.code),
      `deploy gagal harus dengan code bersih, dapat: ${deployErr?.code} (${errMsg(deployErr)})`,
    );
  }

  // §19.2: event tercatat + data valid utuh.
  if (deployOk) {
    assert(deployRes.status === 'success', `deploy harus success, dapat: ${deployRes.status}`);
    const dep = rig.deployMgr.getDeployment(deployRes.deploymentId);
    assert(dep.events.length >= 7, `deployment_events per stage harus tercatat (${dep.events.length})`);
    assert(
      dep.events.every((ev) => ev.status === 'ok'),
      'semua stage event harus ok',
    );
  }
  if (backupOk) {
    const row = rig.bm._backupsDb().db.prepare('SELECT * FROM backups WHERE id = ?').get(backupRes.backupId);
    assert(row, `row backup harus tercatat di backups.db (rows: ${JSON.stringify(rig.bm.listBackups({ limit: 5 }).map((r) => r.id))})`);
    assert(backupRes.verification.ok === true, 'backup harus verification valid');
  }

  // Service hasil deploy tetap sehat (data valid tidak terganggu).
  const svcRow = rig.svcMgr.listServices({ projectId: PROJECT_ID })[0];
  if (svcRow && svcRow.status === 'running') {
    const healthOk = await waitForHttp(
      `http://127.0.0.1:${svcRow.port}/`,
      8000,
      (r) => r.status === 200,
    );
    assert(healthOk, 'service hasil deploy harus tetap menyajikan HTTP 200');
  }

  await rig.close();
  return `backup ${backupOk ? 'sukses (row + verify valid)' : `gagal bersih (${backupErr?.code})`} + deploy ${deployOk ? 'sukses (events per stage)' : `gagal bersih (${deployErr?.code})`} — tanpa deadlock, guard 60s`;
}

/* ------------------------------------------------------------------ */
/* Skenario 23 — Split-brain: dua chain leader, hanya satu menang      */
/* ------------------------------------------------------------------ */

async function scenario23SplitBrain(ctx) {
  const { lockDir, rootDir } = ctx;

  // "Chain leader" = child process; acquireAll semantics (lib/lock.js), TTL.
  const leaderScript = path.join(rootDir, 'lock-leader.mjs');
  const resultFile = path.join(rootDir, 'sandbox-out', 'leader-result.json');
  fs.writeFileSync(
    leaderScript,
    [
      `const { acquireAll, releaseAll } = await import(${modUrl(path.join(ROOT, 'lib', 'lock.js'))});`,
      `const fs = await import('node:fs');`,
      `const lockDir = ${JSON.stringify(lockDir)};`,
      `const res = { pid: process.pid, won: false, code: null, names: [] };`,
      `try {`,
      `  const { acquired } = await acquireAll(['runner.lock'], { dir: lockDir, ttlMs: 10_000, maxWaitMs: 500, retryMs: 50 });`,
      `  res.won = true;`,
      `  res.names = acquired.map((a) => a.name);`,
      `  // Tahan lock (simulasi chain leader aktif) lalu lepas.`,
      `  await new Promise((r) => setTimeout(r, 2500));`,
      `  releaseAll(acquired, { dir: lockDir });`,
      `  res.released = true;`,
      `} catch (e) {`,
      `  res.code = e.code ?? 'ERR';`,
      `} finally {`,
      `  fs.appendFileSync(${JSON.stringify(resultFile)}, JSON.stringify(res) + '\\n');`,
      `}`,
      '',
    ].join('\n'),
  );

  try { fs.unlinkSync(resultFile); } catch { /* tidak ada */ }

  const leaderLog = (n) => path.join(rootDir, 'sandbox-out', `leader-${n}.log`);

  // Leader A mulai dulu; tunggu lock file AKTIF (terpegang) sebelum B jalan —
  // deterministik: B pasti menemukan lock alive (TTL 10s >> jeda), dan A
  // menahan lock 2500ms >> B maxWait 500ms → B pasti gagal LOCK_HELD.
  const a = spawnNode({ argv: [leaderScript], cwd: rootDir, outPath: leaderLog('a') });
  const lockFile = path.join(lockDir, 'runner.lock.lock');
  assert(
    await waitFor(() => fs.existsSync(lockFile), 5000, 25),
    'leader A harus mengambil runner.lock (file lock terbentuk)',
  );
  const b = spawnNode({ argv: [leaderScript], cwd: rootDir, outPath: leaderLog('b') });

  await Promise.all([
    new Promise((r) => a.once('exit', r)),
    new Promise((r) => b.once('exit', r)),
  ]);
  assert(
    await waitFor(() => fs.existsSync(resultFile), 5000, 50),
    'kedua leader harus menulis hasil',
  );
  const results = fs
    .readFileSync(resultFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  assert(results.length === 2, `dua leader harus menulis dua hasil (dapat ${results.length})`);

  // HANYA SATU WINNER (§19.1 #23: tidak ada dua winner).
  const winners = results.filter((r) => r.won === true);
  const losers = results.filter((r) => r.won === false);
  assert(winners.length === 1, `harus tepat satu winner split-brain (dapat ${winners.length})`);
  assert(losers.length === 1, 'harus tepat satu loser');
  assert(losers[0].code === 'LOCK_HELD', `loser harus gagal bersih LOCK_HELD, dapat: ${losers[0].code}`);
  assert(winners[0].names[0] === 'runner.lock', 'winner harus merebut lock runner.lock');
  assert(winners[0].pid !== losers[0].pid, 'winner dan loser harus proses berbeda');

  // Lock lepas setelah release; TTL masih berlaku untuk akuisisi berikutnya.
  const token = await acquire('runner.lock', { dir: lockDir, ttlMs: 5000, maxWaitMs: 2000 });
  release('runner.lock', token, { dir: lockDir });

  // acquireAll semantics (§9.1): akuisisi urut leksikografis + release terbalik.
  const acquired = await acquireAll(['b.lock', 'a.lock', 'runner.lock'], {
    dir: lockDir,
    ttlMs: 5000,
    maxWaitMs: 2000,
  });
  assert(acquired.acquired.length === 3, 'acquireAll harus mendapat semua lock');
  assert(
    acquired.acquired[0].name === 'a.lock' && acquired.acquired[1].name === 'b.lock',
    `acquireAll harus urut leksikografis (dapat: ${acquired.acquired.map((x) => x.name).join(',')})`,
  );
  releaseAll(acquired, { dir: lockDir });
  assert(!fs.existsSync(lockFile), 'lock harus lepas setelah releaseAll');

  return 'dua leader proses: tepat 1 winner runner.lock, loser LOCK_HELD (gagal bersih); TTL + acquireAll leksikografis + releaseAll terverifikasi';
}

/* ------------------------------------------------------------------ */
/* Skenario 24 — Port leak & rekonsiliasi (§6A.2)                      */
/* ------------------------------------------------------------------ */

/** Rekonsiliasi port: registry vs bind test per port; yatim → releasePort. */
async function reconcilePorts(serviceManager, processManager, audit) {
  const rows = serviceManager.store.db.prepare('SELECT port, service_id FROM ports').all();
  const removed = [];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const canBind = await processManager.portBindTest(r.port);
    if (canBind) {
      // Tidak ada listener aktif → port yatim (pemilik mati / drift registry).
      serviceManager.releasePort(r.service_id);
      removed.push({ port: r.port, serviceId: r.service_id });
      audit.push({ event: 'port_reconciled', port: r.port, serviceId: r.service_id, action: 'released_orphan', at: ts() });
    }
  }
  return { checked: rows.length, removed };
}

async function scenario24PortLeak(ctx) {
  const { dataDir, rootDir } = ctx;
  const procMgr = new ProcessManager({ rootDir: path.join(rootDir, 'runtime-24') });
  const svcMgr = new ServiceManager({
    dataDir,
    processManager: procMgr,
    projectsDbPath: path.join(dataDir, 'projects.db'),
  });
  ctx.trackCleanup(() => svcMgr.close());

  const port = await pickFreePort();
  const svc = svcMgr.createService({ projectId: PROJECT_ID, name: 'leak-24', type: 'static', port });
  const started = await svcMgr.startService(svc.id);
  assert(Number.isInteger(started.pid) && started.pid > 0, 'service harus start (pid > 0)');

  let row = svcMgr.store.db.prepare('SELECT * FROM ports WHERE port = ?').get(port);
  assert(row && row.service_id === svc.id, 'ports row tercatat saat running');

  // === Kill child process manual (bukan stopService) → release-on-exit ===
  process.kill(started.pid, 'SIGKILL');
  assert(await waitDead(started.pid), 'child process harus mati setelah SIGKILL manual');

  // Release-on-exit (§6A.2 anti port-leak): exit handler melepas ports row.
  // Tunggu deterministik: row utama hilang = bukti exit handler sudah jalan
  // (event 'exit' child bisa terlambat diproses event loop parent).
  const released = await waitFor(
    () => !svcMgr.store.db.prepare('SELECT * FROM ports WHERE port = ?').get(port),
    10_000,
    100,
  );
  assert(released, 'ports row harus dilepas otomatis oleh exit handler (release-on-exit)');

  // === Orphan row (simulasi crash drift: manager mati sebelum cleanup) ===
  const orphanPort = await pickFreePort();
  try {
    svcMgr.store.db
      .prepare('INSERT INTO ports (port, service_id, bound_host, bound_at) VALUES (?, ?, ?, ?)')
      .run(orphanPort, svc.id, '127.0.0.1', ts());
  } catch (e) {
    throw new ScenarioError(`insert orphan gagal: ${errMsg(e)}; rows=${JSON.stringify(svcMgr.store.db.prepare('SELECT * FROM ports').all())}`);
  }
  row = svcMgr.store.db.prepare('SELECT * FROM ports WHERE port = ?').get(orphanPort);
  assert(
    row,
    `orphan row harus tercatat (port leak terverifikasi; svcPort=${port}, orphanPort=${orphanPort}, svc=${svc.id}, rows=${JSON.stringify(svcMgr.store.db.prepare('SELECT * FROM ports').all())})`,
  );

  // === Rekonsiliasi: bandingkan ports table vs net bind test per port ===
  const audit = [];
  const reconciled = await reconcilePorts(svcMgr, procMgr, audit);

  assert(
    reconciled.removed.some((r) => r.port === orphanPort && r.serviceId === svc.id),
    'rekonsiliasi harus menghapus port yatim',
  );
  row = svcMgr.store.db.prepare('SELECT * FROM ports WHERE port = ?').get(orphanPort);
  assert(!row, 'ports row yatim harus hilang setelah rekonsiliasi');

  // §19.2: event rekonsiliasi tercatat; data valid tidak terhapus.
  assert(audit.some((e) => e.event === 'port_reconciled' && e.port === orphanPort), 'event port_reconciled harus tercatat');
  const rec = svcMgr.getService(svc.id);
  assert(rec && rec.id === svc.id, 'service record tidak boleh dihapus rekonsiliasi (data valid utuh)');
  assert(!reconciled.removed.some((r) => r.serviceId === svc.id && r.port !== orphanPort), 'rekonsiliasi tidak boleh melepas port lain milik service hidup');

  // Service bisa start lagi (registry bersih & konsisten). Status row masih
  // 'running' (SIGKILL tidak mengubah DB — supervisor lane yang menandai);
  // restartService menangani transisi stop→start.
  const restarted = await svcMgr.restartService(svc.id);
  assert(Number.isInteger(restarted.pid) && restarted.pid > 0, 'service harus bisa start lagi setelah rekonsiliasi');
  row = svcMgr.store.db.prepare('SELECT * FROM ports WHERE port = ?').get(port);
  assert(row && row.service_id === svc.id, 'ports row ter-claim ulang saat start');
  await svcMgr.stopService(svc.id);
  const finalRows = svcMgr.store.db.prepare('SELECT COUNT(*) AS c FROM ports').get().c;
  assert(finalRows === 0, `ports table bersih setelah stop (sisa: ${finalRows})`);

  svcMgr.close();
  return `kill manual → release-on-exit melepas port ${port}; orphan row ${orphanPort} dibersihkan rekonsiliasi bind-test (event tercatat); service utuh & start ulang OK`;
}

/* ------------------------------------------------------------------ */
/* rig builders                                                        */
/* ------------------------------------------------------------------ */

export function makeRestoreRig(ctx) {
  return {
    mk() {
      const bm = new BackupManager({
        dataDir: ctx.dataDir,
        backupsRoot: ctx.backupsRoot,
        lockDir: ctx.lockDir,
      });
      const rm = new RestoreManager({
        dataDir: ctx.dataDir,
        backupsRoot: ctx.backupsRoot,
        backupManager: bm,
      });
      return { bm, rm };
    },
  };
}

export function makeDepRig(ctx) {
  const procMgr = new ProcessManager({ rootDir: path.join(ctx.rootDir, 'runtime') });
  const projectMgr = new ProjectManager({
    dataDir: ctx.dataDir,
    workspacesRoot: path.join(ctx.rootDir, 'workspaces'),
  });
  const health = new HealthManager({ dataDir: ctx.dataDir });
  const svcMgr = new ServiceManager({
    dataDir: ctx.dataDir,
    processManager: procMgr,
    projectsDbPath: path.join(ctx.dataDir, 'projects.db'),
  });
  const bm = new BackupManager({
    dataDir: ctx.dataDir,
    backupsRoot: ctx.backupsRoot,
    lockDir: ctx.lockDir,
  });
  const deployMgr = new DeploymentManager({
    dataDir: ctx.dataDir,
    serviceManager: svcMgr,
    projectManager: projectMgr,
    healthManager: health,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const s of svcMgr.listServices()) {
      try {
        await svcMgr.stopService(s.id);
      } catch {
        /* sudah mati */
      }
    }
    try { deployMgr.close(); } catch { /* noop */ }
    try { svcMgr.close(); } catch { /* noop */ }
    try { health.close(); } catch { /* noop */ }
    try { projectMgr.close(); } catch { /* noop */ }
    try { bm.close(); } catch { /* noop */ }
  };
  return { procMgr, projectMgr, health, svcMgr, bm, deployMgr, close, deploy: () => deployMgr.deploy({ projectId: PROJECT_ID, actor: 'sim' }) };
}

/* ------------------------------------------------------------------ */
/* konteks + registry + runner                                         */
/* ------------------------------------------------------------------ */

/** Sandbox per-run: dataDir + projects row fixture + lock dir. */
export async function buildContext() {
  const rootDir = mkdtemp('vmpanel-sim-');
  const dataDir = path.join(rootDir, 'data');
  const backupsRoot = path.join(rootDir, 'backups');
  const lockDir = path.join(rootDir, 'runtime', 'locks');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupsRoot, { recursive: true });
  fs.mkdirSync(lockDir, { recursive: true });

  const ctx = {
    rootDir,
    dataDir,
    backupsRoot,
    lockDir,
    projectId: PROJECT_ID,
    cleanups: [],
    trackCleanup(fn) {
      ctx.cleanups.push(fn);
    },
  };

  // Project fixture (static adapter; workspace index.html; port legal bebas).
  const deployPort = await pickFreePort();
  const projects = openDatabase(path.join(dataDir, 'projects.db'), { schemaName: 'projects' });
  projects.migrate();
  projects.db
    .prepare(
      `INSERT INTO projects (id, name, type, status, workspace_path, port, created_at)
       VALUES (?, 'sim-app', 'static', 'stopped', ?, ?, '2026-01-01T00:00:00Z')`,
    )
    .run(PROJECT_ID, path.join(rootDir, 'workspaces', PROJECT_ID), deployPort);
  projects.close();
  fs.mkdirSync(path.join(rootDir, 'workspaces', PROJECT_ID), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'workspaces', PROJECT_ID, 'index.html'),
    '<!doctype html><html><body>sim-fixture</body></html>\n',
  );

  return ctx;
}

export async function runContextCleanup(ctx) {
  for (const fn of ctx.cleanups.splice(0)) {
    try {
      await fn();
    } catch {
      /* best-effort */
    }
  }
  // Debug: VMPANEL_KEEP=1 → sandbox dibiarkan (bisa diperiksa manual).
  if (process.env.VMPANEL_KEEP === '1') {
    console.error(`[simulate] keep sandbox: ${ctx.rootDir}`);
    return;
  }
  rmWithRetry(ctx.rootDir);
}

export const SCENARIOS = [
  { id: 5, title: 'Manager mati + external watchdog restart + state utuh', fn: scenario5ManagerDeath },
  { id: 6, title: 'Panel mati + external watchdog restart + state utuh', fn: scenario6PanelDeath },
  { id: 19, title: 'Manager mati di tengah restore → restore ulang idempotent', fn: scenario19RestoreCrash },
  { id: 20, title: 'Supervisor mati mid-recovery → supervisor baru lanjut konsisten', fn: scenario20SupervisorMidRecovery },
  { id: 21, title: 'Backup vs deployment konkuren → tidak deadlock', fn: scenario21BackupVsDeploy },
  { id: 23, title: 'Split-brain: dua chain leader rebutan runner.lock', fn: scenario23SplitBrain },
  { id: 24, title: 'Port leak & rekonsiliasi registry', fn: scenario24PortLeak },
];

function parseArgs(argv) {
  const out = { only: null, report: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') {
      const v = argv[++i] ?? '';
      out.only = v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
    } else if (a === '--report') {
      out.report = argv[++i] ?? null;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function writeReport(reportPath, results, failedCount) {
  const lines = [];
  lines.push('');
  lines.push(`## Failure Simulation Run ${ts()}`);
  lines.push('');
  lines.push(
    'Harness: `tests/recovery/simulate.js` (DESIGN.md §19.3). Skenario 1-4, 8-11, 13-18 sudah tercover unit test (tidak diduplikasi). Skenario 7/12/22 butuh GitHub Actions live drill — di luar scope harness lokal.',
  );
  lines.push('');
  lines.push('| # | Skenario | Hasil | Detail |');
  lines.push('|---|----------|-------|--------|');
  for (const r of results) {
    const title = r.title.replace(/\|/g, '\\|');
    const detail = String(r.detail).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 400);
    lines.push(`| ${r.id} | ${title} | ${r.status} | ${detail} |`);
  }
  lines.push('');
  lines.push(`Total: ${results.length} skenario — ${failedCount === 0 ? 'semua PASS' : `${failedCount} FAIL`}.`);
  lines.push('');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.appendFileSync(reportPath, lines.join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node tests/recovery/simulate.js [--only 5,19] [--report docs/test-report.md]');
    process.exit(0);
  }
  const selected = args.only ? SCENARIOS.filter((s) => args.only.includes(s.id)) : SCENARIOS;
  if (selected.length === 0) {
    console.error('tidak ada skenario yang cocok --only');
    process.exit(2);
  }

  const ctx = await buildContext();
  const results = [];
  let failedCount = 0;

  for (const scenario of selected) {
    const startedAt = ts();
    let status = 'PASS';
    let detail = '';
    try {
      detail = await scenario.fn(ctx);
    } catch (e) {
      status = 'FAIL';
      failedCount += 1;
      detail = errMsg(e);
    }
    results.push({ id: scenario.id, title: scenario.title, status, detail, startedAt, finishedAt: ts() });
    console.log(`[${status}] Skenario ${scenario.id}: ${scenario.title}`);
    if (detail) console.log(`        ${detail}`);
  }

  await runContextCleanup(ctx);

  const reportPath = args.report
    ? path.resolve(args.report)
    : path.join(ROOT, 'docs', 'test-report.md');
  writeReport(reportPath, results, failedCount);

  console.log(`\n${failedCount === 0 ? 'SEMUA PASS' : `${failedCount} GAGAL`} — laporan: ${reportPath}`);
  process.exit(failedCount === 0 ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error('simulate.js fatal:', e);
    process.exit(1);
  });
}
