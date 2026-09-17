#!/usr/bin/env node
// bin/sync-port.mjs — Sinkronisasi otomatis port SSH VPS ke ~/.ssh/config.
// Dirancang untuk dijalankan di background oleh Windows Task Scheduler atau saat folder dibuka.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadDotEnv } from '../lib/env.js';
import { decryptConnection, updateSshConfig } from '../scripts/vps-connection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

loadDotEnv(rootDir);
const masterKey = process.env.VPANEL_MASTER_KEY;

function getRepo() {
  try {
    const url = execSync('git config --get remote.origin.url', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {}
  return 'mensir122/vm-panel';
}

const repo = getRepo();

function fetchConnection() {
  try {
    const raw = execSync(`gh api "repos/${repo}/contents/vps-connection.enc?ref=state" --jq .content`, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (raw && masterKey) {
      const envelope = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      return decryptConnection(envelope, masterKey);
    }
  } catch {}

  try {
    const raw = execSync(`gh api "repos/${repo}/contents/vps-connection.json?ref=state" --jq .content`, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (raw) {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    }
  } catch {}

  return null;
}

function getCurrentConfigPort() {
  try {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(configPath)) return null;
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/Host vpanel-vps[\s\S]*?Port\s+(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

async function main() {
  const isSilent = process.argv.includes('--silent');
  const conn = fetchConnection();

  if (!conn || (!conn.port && !conn.ssh_cmd)) {
    if (!isSilent) console.error('[vps-sync] Detail koneksi belum tersedia di cloud.');
    process.exit(0);
  }

  let targetPort = conn.port;
  if (!targetPort && conn.ssh_cmd) {
    const m = conn.ssh_cmd.match(/-p\s+(\d+)/);
    if (m) targetPort = parseInt(m[1], 10);
  }

  const currentPort = getCurrentConfigPort();

  const configPath = path.join(os.homedir(), '.ssh', 'config');
  const oldContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const newContent = updateSshConfig(conn);

  if (oldContent === newContent) {
    if (!isSilent) {
      console.log(`[vps-sync] Port dan konfigurasi sudah sesuai (${targetPort}). Tidak ada perubahan.`);
    }
    process.exit(0);
  }

  if (!isSilent) {
    console.log(`\x1b[32m[✓] Port VPS berhasil disinkronkan ke ~/.ssh/config: ${currentPort || 'none'} -> ${targetPort}\x1b[0m`);
  }
}

main().catch((err) => {
  if (!process.argv.includes('--silent')) {
    console.error('[vps-sync error]', err.message);
  }
  process.exit(0);
});
