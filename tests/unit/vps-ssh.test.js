// tests/unit/vps-ssh.test.js — Validasi statis script VPS SSH & Tunnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');

const read = (p) => fs.readFileSync(p, 'utf8');

test('setup_vps_ssh.sh: konfigurasi OpenSSH aman, pubkey auth, MOTD, dan symlink vmctl', () => {
  const file = path.join(SCRIPTS, 'setup_vps_ssh.sh');
  assert.ok(fs.existsSync(file), 'setup_vps_ssh.sh wajib ada');
  const s = read(file);

  assert.match(s, /set -euo pipefail/, 'wajib set -euo pipefail');
  assert.match(s, /\[setup_vps_ssh\]/, 'log prefix [setup_vps_ssh]');
  assert.match(s, /SSH_PUBLIC_KEY/, 'menggunakan environment SSH_PUBLIC_KEY');
  assert.match(s, /authorized_keys/, 'menulis ke authorized_keys');
  assert.match(s, /PasswordAuthentication no/, 'wajib menonaktifkan password authentication');
  assert.match(s, /PubkeyAuthentication yes/, 'wajib mengaktifkan pubkey authentication');
  assert.match(s, /NOPASSWD:ALL/, 'memberikan hak sudo tanpa password');
  assert.match(s, /vmctl/, 'menyiapkan symlink vmctl');

  // Tanpa secret literal atau PAT
  assert.ok(!/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(s), 'tanpa PAT');
  assert.ok(!/(password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(s.replace(/\$\{[^}]+\}/g, '')), 'tanpa literal secret');
});

test('start_tunnel.sh: provider Tailscale vpanel-vps, Cloudflare, Ngrok, dan fallback Tmate', () => {
  const file = path.join(SCRIPTS, 'start_tunnel.sh');
  assert.ok(fs.existsSync(file), 'start_tunnel.sh wajib ada');
  const s = read(file);

  assert.match(s, /set -euo pipefail/, 'wajib set -euo pipefail');
  assert.match(s, /\[start_tunnel\]/, 'log prefix [start_tunnel]');
  assert.match(s, /TAILSCALE_AUTHKEY/, 'mendukung Tailscale');
  assert.match(s, /hostname="?vpanel-vps"?/, 'hostname statis vpanel-vps');
  assert.match(s, /CLOUDFLARE_TUNNEL_TOKEN/, 'mendukung Cloudflare Tunnel');
  assert.match(s, /NGROK_AUTHTOKEN/, 'mendukung Ngrok TCP');
  assert.match(s, /tmate/, 'mendukung fallback Tmate');

  // Tanpa secret literal atau PAT
  assert.ok(!/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(s), 'tanpa PAT');
  assert.ok(!/(password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(s.replace(/\$\{[^}]+\}/g, '')), 'tanpa literal secret');
});
