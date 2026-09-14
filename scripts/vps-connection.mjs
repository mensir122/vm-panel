// scripts/vps-connection.mjs — Manajemen state koneksi SSH VPS (Zero-Install).
// Mendukung enkripsi AES-256-GCM atas koneksi tunnel agar aman di branch public/state.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { aesEncrypt, aesDecrypt, deriveKey } from '../lib/crypto.js';

const KDF_SALT = 'vps-conn-salt';
const KDF_LABEL = 'vps-tunnel-connection';

/**
 * Derive 32-byte key untuk enkripsi koneksi dari VPANEL_MASTER_KEY.
 * @param {string} masterKey
 * @returns {Buffer}
 */
export function getConnKey(masterKey) {
  if (!masterKey || typeof masterKey !== 'string') {
    throw new Error('masterKey wajib berupa string non-kosong');
  }
  return deriveKey(masterKey, KDF_SALT, KDF_LABEL);
}

/**
 * Enkripsi objek koneksi menjadi envelope AES-256-GCM.
 * @param {object} connObj
 * @param {string} masterKey
 * @returns {object} { iv, tag, ct }
 */
export function encryptConnection(connObj, masterKey) {
  const key = getConnKey(masterKey);
  const payload = JSON.stringify(connObj);
  return aesEncrypt(key, payload);
}

/**
 * Dekripsi envelope AES-256-GCM menjadi objek koneksi.
 * @param {object} envelope
 * @param {string} masterKey
 * @returns {object}
 */
export function decryptConnection(envelope, masterKey) {
  const key = getConnKey(masterKey);
  const plaintext = aesDecrypt(key, envelope);
  return JSON.parse(plaintext);
}

/**
 * Format string perintah SSH dengan argumen keamanan dan private key.
 * @param {string} rawSshCmd - misal "ssh foo@bar.tmate.io" atau "ssh runner@vpanel-vps"
 * @param {object} [opts]
 * @param {string} [opts.keyPath] - path ke private key (default: ~/.ssh/id_ed25519 jika ada)
 * @returns {{ command: string, args: string[] }}
 */
export function parseSshCommand(rawSshCmd, opts = {}) {
  if (!rawSshCmd || typeof rawSshCmd !== 'string') {
    throw new Error('rawSshCmd wajib berupa string');
  }

  // Parse raw parts: "ssh foo@bar.tmate.io -p 2222" -> tokens
  const tokens = rawSshCmd.trim().split(/\s+/).filter(Boolean);
  const baseCmd = tokens[0] === 'ssh' ? tokens[0] : 'ssh';
  const rawArgs = tokens[0] === 'ssh' ? tokens.slice(1) : tokens;

  const home = os.homedir();
  const defaultKey = path.join(home, '.ssh', 'id_ed25519');
  const keyToUse = opts.keyPath || (fs.existsSync(defaultKey) ? defaultKey : null);

  const finalArgs = [];

  // Sisipkan opsi keamanan dan kenyamanan
  finalArgs.push('-o', 'StrictHostKeyChecking=accept-new');
  finalArgs.push('-o', 'ServerAliveInterval=30');
  finalArgs.push('-o', 'ServerAliveCountMax=3');

  if (keyToUse) {
    finalArgs.push('-i', keyToUse);
    finalArgs.push('-o', 'IdentitiesOnly=yes');
  }

  finalArgs.push(...rawArgs);

  return {
    command: baseCmd,
    args: finalArgs,
    fullCommand: `${baseCmd} ${finalArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
  };
}

/**
 * Update atau sisipkan konfigurasi Host vpanel-vps di ~/.ssh/config.
 * Berguna untuk integrasi otomatis dengan VS Code Remote - SSH.
 * @param {object} conn - objek koneksi { host, port, user }
 * @param {object} [opts] - opsi custom direktori/path untuk pengujian
 * @returns {string|null} content konfigurasi yang baru
 */
export function updateSshConfig(conn, opts = {}) {
  if (!conn) {
    return null;
  }

  let host = conn.host;
  let port = conn.port;
  let user = conn.user;

  // Jika host/port belum eksplisit, parse dari ssh_cmd
  if ((!host || !port) && conn.ssh_cmd) {
    const pMatch = conn.ssh_cmd.match(/-p\s+(\d+)/);
    port = port || (pMatch ? parseInt(pMatch[1], 10) : 22);

    const target = conn.ssh_cmd.replace(/^ssh\s+/, '').trim().split(/\s+/)[0];
    if (target.includes('@')) {
      const parts = target.split('@');
      user = user || parts[0];
      host = host || parts[1];
    } else {
      host = host || target;
      user = user || 'runner';
    }
  }

  if (!host) {
    return null;
  }

  port = port || 22;
  user = user || 'runner';

  const home = opts.homeDir || os.homedir();
  const sshDir = opts.sshDir || path.join(home, '.ssh');
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true });
  }
  const configPath = opts.configPath || path.join(sshDir, 'config');
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';

  const idKey = path.join(sshDir, 'id_ed25519').replace(/\\/g, '/');
  const blockHeader = '# === VPANEL VPS 24/7 AUTO CONFIG ===';
  const blockFooter = '# === END VPANEL VPS ===';
  const newBlock = `${blockHeader}
Host vpanel-vps
    HostName ${host}
    Port ${port}
    User ${user}
    IdentityFile "${idKey}"
    StrictHostKeyChecking accept-new
    ServerAliveInterval 30
    ServerAliveCountMax 3
${blockFooter}`;

  if (content.includes(blockHeader) && content.includes(blockFooter)) {
    const regex = new RegExp(`${blockHeader}[\\s\\S]*?${blockFooter}`, 'g');
    content = content.replace(regex, newBlock);
  } else {
    content = content ? `${content.trim()}\n\n${newBlock}\n` : `${newBlock}\n`;
  }

  fs.writeFileSync(configPath, content, { encoding: 'utf8' });
  return content;
}

// CLI handler untuk dijalankan langsung dari shell / workflow
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'encrypt') {
    const src = process.argv[3];
    const dest = process.argv[4];
    const key = process.env.VPANEL_MASTER_KEY;
    if (!src || !dest || !key) {
      console.error('Usage: VPANEL_MASTER_KEY=... node vps-connection.mjs encrypt <src.json> <dest.enc>');
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    const enc = encryptConnection(data, key);
    fs.writeFileSync(dest, JSON.stringify(enc, null, 2), 'utf8');
    console.log(`Terenkripsi ke ${dest}`);
  } else if (mode === 'decrypt') {
    const src = process.argv[3];
    const key = process.env.VPANEL_MASTER_KEY;
    if (!src || !key) {
      console.error('Usage: VPANEL_MASTER_KEY=... node vps-connection.mjs decrypt <src.enc>');
      process.exit(1);
    }
    const enc = JSON.parse(fs.readFileSync(src, 'utf8'));
    const data = decryptConnection(enc, key);
    console.log(JSON.stringify(data, null, 2));
  }
}
