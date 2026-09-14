#!/usr/bin/env node
// bin/connect-vps.js — CLI penghubung SSH ke Headless VPS 24/7 (Zero-Install).
// Menarik data koneksi terenkripsi dari branch 'state' lalu menjalankan native OpenSSH.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { loadDotEnv } from '../lib/env.js';
import { decryptConnection, parseSshCommand } from '../scripts/vps-connection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// 1. Muat env lokal
loadDotEnv(rootDir);
const masterKey = process.env.VPANEL_MASTER_KEY;

// 2. Deteksi Repo GitHub
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printBanner(conn) {
  console.log('\n\x1b[36m┌──────────────────────────────────────────────────────────────┐\x1b[0m');
  console.log('\x1b[36m│\x1b[1m\x1b[37m              ORIONT VPS 24/7 — HEADLESS LINUX ENGINE          \x1b[0m\x1b[36m│\x1b[0m');
  console.log('\x1b[36m├──────────────────────────────────────────────────────────────┤\x1b[0m');
  console.log(`\x1b[36m│\x1b[0m  Runner ID  : \x1b[33m#${conn.run_id || 'active'}\x1b[0m`.padEnd(68) + '\x1b[36m│\x1b[0m');
  console.log(`\x1b[36m│\x1b[0m  Provider   : \x1b[32m${conn.provider || 'tmate'} (Zero-Trust Key Enforced)\x1b[0m`.padEnd(73) + '\x1b[36m│\x1b[0m');
  console.log(`\x1b[36m│\x1b[0m  Kunci SSH  : \x1b[35m~/.ssh/id_ed25519 (Private)\x1b[0m`.padEnd(69) + '\x1b[36m│\x1b[0m');
  console.log('\x1b[36m└──────────────────────────────────────────────────────────────┘\x1b[0m\n');
  console.log('\x1b[90mMenghubungkan ke terminal Ubuntu (Ketik \x1b[37mexit\x1b[90m untuk keluar)...\x1b[0m\n');
}

async function fetchConnectionData() {
  // Coba ambil file terenkripsi terlebih dahulu
  try {
    const raw = execSync(`gh api "repos/${repo}/contents/vps-connection.enc?ref=state" --jq .content`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (raw) {
      const envelopeStr = Buffer.from(raw, 'base64').toString('utf8');
      const envelope = JSON.parse(envelopeStr);
      if (!masterKey) {
        throw new Error(
          'File koneksi terenkripsi (vps-connection.enc), tetapi VPANEL_MASTER_KEY tidak ditemukan di .env'
        );
      }
      return decryptConnection(envelope, masterKey);
    }
  } catch (err) {
    if (err.message && err.message.includes('VPANEL_MASTER_KEY')) {
      throw err;
    }
  }

  // Fallback ke unencrypted jika ada
  try {
    const raw = execSync(`gh api "repos/${repo}/contents/vps-connection.json?ref=state" --jq .content`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (raw) {
      const jsonStr = Buffer.from(raw, 'base64').toString('utf8');
      return JSON.parse(jsonStr);
    }
  } catch {}

  return null;
}

async function ensureWorkflowRunning() {
  try {
    const out = execSync(`gh run list --workflow=vm.yml --limit=1 --json status,conclusion,databaseId`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const runs = JSON.parse(out);
    if (runs.length > 0 && runs[0].status === 'in_progress') {
      return runs[0];
    }
  } catch {}

  console.log('\x1b[33m[!] Tidak ada runner VPS aktif. Memicu workflow VM 24/7 baru...\x1b[0m');
  try {
    execSync('gh workflow run vm.yml --ref main', {
      cwd: rootDir,
      stdio: 'inherit',
    });
    console.log('\x1b[32m[✓] Workflow terpicu. Menunggu runner menginisialisasi SSH...\x1b[0m');
  } catch (err) {
    console.error('\x1b[31m[✗] Gagal memicu workflow:', err.message, '\x1b[0m');
    process.exit(1);
  }
  return null;
}

async function main() {
  const isVscode = process.argv.includes('--vscode');
  const isInfo = process.argv.includes('--info');

  console.log('\x1b[34m[vps] Memeriksa status Headless VPS di GitHub Actions...\x1b[0m');

  await ensureWorkflowRunning();

  let conn = null;
  const maxAttempts = 24; // 24 * 5 detik = 120 detik maks tunggu
  process.stdout.write('\x1b[90m[vps] Mengambil info sesi SSH dari cloud\x1b[0m');

  for (let i = 0; i < maxAttempts; i++) {
    process.stdout.write('.');
    conn = await fetchConnectionData();
    if (conn && conn.ssh_cmd) {
      process.stdout.write(' [Siap]\n');
      break;
    }
    await sleep(5000);
  }

  if (!conn || !conn.ssh_cmd) {
    console.error('\n\x1b[31m[✗] Waktu habis: Detail koneksi SSH belum tersedia di branch state.\x1b[0m');
    console.error('Silakan periksa log workflow di GitHub Actions atau coba lagi sebentar lagi:');
    console.error('  gh run list --workflow=vm.yml');
    process.exit(1);
  }

  // Ekstrak target user@host dari string SSH (contoh: "ssh foo@uptermd.upterm.dev" -> "foo@uptermd.upterm.dev")
  const target = conn.ssh_cmd.replace(/^ssh\s+/, '').split(/\s+/)[0];

  if (isInfo) {
    console.log('\n\x1b[36m┌──────────────────────────────────────────────────────────────┐\x1b[0m');
    console.log('\x1b[36m│\x1b[1m\x1b[37m            INFORMASI KONEKSI VPS LINUX UBUNTU                 \x1b[0m\x1b[36m│\x1b[0m');
    console.log('\x1b[36m├──────────────────────────────────────────────────────────────┤\x1b[0m');
    console.log(`\x1b[36m│\x1b[0m  Perintah SSH  : \x1b[32m${conn.ssh_cmd}\x1b[0m`.padEnd(68) + '\x1b[36m│\x1b[0m');
    console.log(`\x1b[36m│\x1b[0m  Remote Target : \x1b[33m${target}\x1b[0m`.padEnd(68) + '\x1b[36m│\x1b[0m');
    console.log(`\x1b[36m│\x1b[0m  Kunci Privat  : \x1b[35m~/.ssh/id_ed25519\x1b[0m`.padEnd(68) + '\x1b[36m│\x1b[0m');
    console.log('\x1b[36m└──────────────────────────────────────────────────────────────┘\x1b[0m\n');
    console.log('Untuk koneksi manual di VS Code (Remote - SSH):');
    console.log(`1. Tekan F1 di VS Code -> Pilih: Remote-SSH: Connect to Host...`);
    console.log(`2. Masukkan target: ${conn.ssh_cmd}`);
    console.log(`3. Pilih platform: Linux\n`);
    process.exit(0);
  }

  if (isVscode) {
    const uri = `vscode-remote://ssh-remote+${target}/home/runner`;
    console.log('\n\x1b[32m[✓] Membuka VS Code Remote ke VPS Ubuntu (/home/runner)...\x1b[0m');
    console.log(`\x1b[90mURI: ${uri}\x1b[0m\n`);
    spawnSync('code', ['--folder-uri', uri], { shell: true, stdio: 'inherit' });
    process.exit(0);
  }

  printBanner(conn);

  const parsed = parseSshCommand(conn.ssh_cmd);

  // Jalankan sesi SSH secara interaktif penuh (TTY diwariskan ke terminal pengguna)
  const result = spawnSync(parsed.command, parsed.args, {
    stdio: 'inherit',
  });

  console.log('\n\x1b[32m[✓] Sesi SSH selesai. VPS tetap berjalan 24/7 di GitHub Actions.\x1b[0m');
  process.exit(result.status ?? 0);
}

main().catch((err) => {
  console.error('\n\x1b[31m[Error]\x1b[0m', err.message);
  process.exit(1);
});
