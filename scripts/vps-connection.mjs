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
