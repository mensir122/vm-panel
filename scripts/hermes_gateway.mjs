#!/usr/bin/env node
// scripts/hermes_gateway.mjs — Daemon runner untuk Hermes Agent Gateway
// Mengonfigurasi Hermes Agent dengan 9Router (port 20127) dan mengaktifkan
// OpenAI-compatible API server di port 8642 untuk integrasi VM-Panel.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const HERMES_HOME = process.env.HERMES_HOME || path.join(LOCALAPPDATA, 'hermes');
const HERMES_EXE = process.platform === 'win32'
  ? path.join(HERMES_HOME, 'bin', 'hermes.exe')
  : path.join(HERMES_HOME, 'bin', 'hermes');
const HERMES_PY = process.platform === 'win32'
  ? path.join(HERMES_HOME, 'bin', 'python.exe')
  : path.join(HERMES_HOME, 'bin', 'python');

const GATEWAY_PORT = Number(process.env.HERMES_GATEWAY_PORT || 8642);
const ROUTER_URL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:20127/v1';

// Pastikan skill vm-panel disalin ke folder skills hermes
function syncSkills() {
  try {
    const srcSkill = path.join(ROOT, 'data', 'hermes', 'skills', 'vm-panel');
    const destSkill = path.join(HERMES_HOME, 'skills', 'vm-panel');
    if (fs.existsSync(srcSkill)) {
      fs.mkdirSync(destSkill, { recursive: true });
      fs.copyFileSync(path.join(srcSkill, 'SKILL.md'), path.join(destSkill, 'SKILL.md'));
      console.log(`[hermes_gateway] Skill vm-panel disinkronkan ke: ${destSkill}`);
    }
  } catch (err) {
    console.warn(`[hermes_gateway] Gagal menyinkronkan skill: ${err.message}`);
  }
}

export function findHermesCommand() {
  const candidates = [
    { cmd: path.join(HERMES_HOME, 'bin', process.platform === 'win32' ? 'hermes.exe' : 'hermes'), args: ['gateway', 'run', '--accept-hooks'] },
    { cmd: path.join(HERMES_HOME, 'bin', 'hermes.cmd'), args: ['gateway', 'run', '--accept-hooks'] },
    { cmd: path.join(HERMES_HOME, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'), args: ['gateway', 'run', '--accept-hooks'] },
    { cmd: path.join(HERMES_HOME, 'hermes-agent', 'venv', 'bin', 'hermes'), args: ['gateway', 'run', '--accept-hooks'] },
    { cmd: path.join(HERMES_HOME, 'hermes-agent', 'venv', 'Scripts', 'python.exe'), args: ['-m', 'hermes_cli.main', 'gateway', 'run', '--accept-hooks'] },
    { cmd: path.join(HERMES_HOME, 'hermes-agent', 'venv', 'bin', 'python'), args: ['-m', 'hermes_cli.main', 'gateway', 'run', '--accept-hooks'] },
    { cmd: path.join(HERMES_HOME, 'bin', process.platform === 'win32' ? 'python.exe' : 'python'), args: ['-m', 'hermes_cli.main', 'gateway', 'run', '--accept-hooks'] },
  ];

  for (const c of candidates) {
    if (fs.existsSync(c.cmd)) {
      return c;
    }
  }
  return null;
}

export async function isGatewayAlive(timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);
    if (res && res.status < 500) return true;

    // Coba juga cek root atau models endpoint
    const resModels = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);
    return !!(resModels && resModels.status < 500);
  } catch {
    return false;
  }
}

async function run() {
  syncSkills();
  const hermes = findHermesCommand();
  if (!hermes) {
    console.error(`[hermes_gateway] Hermes Agent belum terinstal di ${HERMES_HOME}`);
    console.error(`[hermes_gateway] Silakan jalankan 'powershell -File scripts/install_hermes.ps1' terlebih dahulu.`);
    process.exit(1);
  }

  console.log(`[hermes_gateway] Menjalankan Hermes Gateway: ${hermes.cmd} ${hermes.args.join(' ')}`);
  console.log(`[hermes_gateway] Target LLM (9Router): ${ROUTER_URL}`);
  console.log(`[hermes_gateway] API Server Port: ${GATEWAY_PORT}`);

  const env = {
    ...process.env,
    API_SERVER_ENABLED: 'true',
    API_SERVER_PORT: String(GATEWAY_PORT),
    API_SERVER_HOST: '127.0.0.1',
    OPENAI_BASE_URL: ROUTER_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-vm-panel-local',
    HERMES_HOME,
  };

  const child = spawn(hermes.cmd, hermes.args, {
    cwd: HERMES_HOME,
    env,
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('exit', (code, signal) => {
    console.log(`[hermes_gateway] Proses gateway berhenti (code=${code} signal=${signal})`);
    process.exit(code ?? 0);
  });

  const stop = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((e) => {
    console.error(`[hermes_gateway] Error:`, e);
    process.exit(1);
  });
}
