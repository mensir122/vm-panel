#!/usr/bin/env node
// start-all.mjs - SATU PERINTAH: nyalakan manager + panel sekaligus.
//   npm start
// - manager health-check dulu (bearer token dari runtime/sockets/cli-token),
//   lalu panel dinyalakan, lalu panel di-health-check.
// - Ctrl+C sekali: mematikan keduanya dengan rapi.
// - Port bisa dioverride via env MANAGER_API_PORT / PANEL_PORT (untuk test).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MPORT = Number(process.env.MANAGER_API_PORT || 8097);
const PPORT = Number(process.env.PANEL_PORT || 8080);
const TOKEN_FILE = path.join(ROOT, 'runtime', 'sockets', 'cli-token');

const kids = [];
let shuttingDown = false;

function tag(name, buf) {
  return String(buf)
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => `[${name}] ${l}`)
    .join('\n');
}

function spawnProc(name, script) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write(tag(name, d) + '\n'));
  child.stderr.on('data', (d) => process.stderr.write(tag(name, d) + '\n'));
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      process.stderr.write(`[${name}] BERHENTI sendiri (code=${code} signal=${signal ?? ''})\n`);
    }
  });
  kids.push({ name, child });
  return child;
}

async function waitFor(fn, timeoutMs, stepMs = 300) {
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
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of kids) {
    try {
      child.kill();
    } catch {
      /* sudah mati */
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  for (const { child } of kids) {
    try {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
  }
  process.exit(code);
}

async function main() {
  // 1. Manager dulu (satu-satunya penulis DB).
  spawnProc('manager', 'manager/index.js');
  const mgrOk = await waitFor(async () => {
    if (!fs.existsSync(TOKEN_FILE)) return false;
    const tok = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!tok) return false;
    const r = await fetch(`http://127.0.0.1:${MPORT}/health`, {
      headers: { Authorization: `Bearer ${tok}` },
      signal: AbortSignal.timeout(1500),
    });
    return r.status === 200;
  }, 120_000);
  if (!mgrOk) {
    console.error('[start-all] GAGAL: manager tidak sehat dalam 120s');
    await shutdown(1);
    return;
  }
  console.log(`[start-all] manager OK (port ${MPORT})`);

  // 2. Panel (UI).
  spawnProc('panel', 'panel/server/index.js');
  const panelOk = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${PPORT}/login`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.status === 200;
  }, 60_000);
  if (!panelOk) {
    console.error('[start-all] GAGAL: panel tidak sehat dalam 60s');
    await shutdown(1);
    return;
  }
  console.log(`[start-all] panel OK (port ${PPORT})`);
  console.log(`[start-all] SEMUANYA MENYALA -> buka http://127.0.0.1:${PPORT}`);
  console.log('[start-all] Ctrl+C untuk mematikan keduanya.');
}

process.on('SIGINT', () => {
  console.log('\n[start-all] Ctrl+C - mematikan manager + panel...');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

main().catch((e) => {
  console.error(`[start-all] ${e?.message ?? e}`);
  shutdown(1);
});
