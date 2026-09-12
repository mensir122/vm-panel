#!/usr/bin/env node
// scripts/start-vm-router.mjs — 9Router Khusus VM (Port 20127) Terisolasi Total
// Menjamin database dan proses 100% independen dari 9Router harian (Port 20128):
//   1. DATA_DIR terisolasi: %APPDATA%\9router-vm\db\data.sqlite (tidak menyentuh 9router harian)
//   2. Path eksekusi terisolasi: %APPDATA%\vm-router\app (kebal dari killAllAppProcesses cli 9router)
//   3. Port terikat: 127.0.0.1:20127

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const PORT = process.env.ROUTER_PORT || '20127';
const HOST = process.env.ROUTER_HOST || '127.0.0.1';
const DATA_DIR = process.env.ROUTER_DATA_DIR || path.join(process.env.APPDATA || '', '9router-vm');
const APP_DIR = path.join(process.env.APPDATA || '', 'vm-router', 'app');
const SERVER_JS = path.join(APP_DIR, 'server.js');

if (!fs.existsSync(SERVER_JS)) {
  console.error(`[vm-router] Error: Server binary tidak ditemukan di ${SERVER_JS}`);
  process.exit(1);
}

// Pastikan direktori data & db terisolasi tersedia
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });

const env = {
  ...process.env,
  PORT,
  HOSTNAME: HOST,
  DATA_DIR,
  NODE_ENV: 'production',
  NODE_PATH: [
    path.join(process.env.APPDATA || '', '9router', 'runtime', 'node_modules'),
    path.join(APP_DIR, 'node_modules'),
  ].join(path.delimiter),
};

console.log(`[vm-router] Memulai 9Router VM terisolasi...`);
console.log(`[vm-router] Port     : http://${HOST}:${PORT}`);
console.log(`[vm-router] Data Dir : ${DATA_DIR} (Terpisah dari 9router port 20128)`);

const child = spawn(
  process.execPath,
  ['--dns-result-order=ipv4first', '--max-old-space-size=4096', SERVER_JS],
  {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

child.stdout.on('data', (d) => {
  const str = d.toString().trim();
  if (str) console.log(`[vm-router] ${str}`);
});

child.stderr.on('data', (d) => {
  const str = d.toString().trim();
  if (str) console.error(`[vm-router-err] ${str}`);
});

child.on('exit', (code, signal) => {
  console.log(`[vm-router] Berhenti (code=${code}, signal=${signal})`);
  process.exit(code ?? 0);
});

function handleSignal(sig) {
  console.log(`[vm-router] Menerima sinyal ${sig}, mematikan server...`);
  try {
    child.kill('SIGTERM');
  } catch {}
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
