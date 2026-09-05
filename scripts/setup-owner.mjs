#!/usr/bin/env node
// scripts/setup-owner.mjs - setup akun admin pertama VM-Panel (sekali jalan).
//
// Pemakaian:
//   node scripts/setup-owner.mjs "PasswordKuat123"
//   node scripts/setup-owner.mjs "PasswordKuat123" "nama-login-anda"   (opsional rename)
//
// Output: TOTP secret (untuk aplikasi authenticator) + 10 recovery codes.
// Prasyarat: manager/panel boleh jalan (WAL aman), tapi bootstrap hanya
// berhasil SEKALI - setelah itu login pakai password + kode 2FA.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PanelAuth } from '../panel/server/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Muat .env sederhana (KEY=VALUE) agar kunci TOTP konsisten dengan kunci milikmu.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const [password, renameTo] = process.argv.slice(2);

if (!password || password.length < 8) {
  console.error(`
[setup-owner] Pemakaian:
  node scripts/setup-owner.mjs "PasswordAndaMinimal8"
  node scripts/setup-owner.mjs "PasswordAndaMinimal8" "NamaLogin"   (opsional)

Password minimal 8 karakter. Ini password LOGIN panel - pilih yang kuat
dan simpan di tempat aman (sama seperti VPANEL_MASTER_KEY).`);
  process.exit(2);
}
if (/[&<>|"'`$;]/.test(renameTo ?? '')) {
  console.error('[setup-owner] Nama login hanya huruf/angka/-/_ tanpa karakter spesial.');
  process.exit(2);
}

const auth = new PanelAuth({ dataDir: path.join(ROOT, 'data') });

// Cek owner yang sudah ada: pakai user owner pertama (biasanya 'system').
const owners = auth.listUsers().filter((u) => u.role === 'owner');
if (owners.length === 0) {
  console.error('[setup-owner] Tidak ada owner di database. Jalankan manager dulu sekali (npm start).');
  process.exit(1);
}
let owner = owners[0];

// Rename (opsional) sebelum bootstrap, agar nama login sesuai keinginan.
if (renameTo && renameTo !== owner.username) {
  const db = auth;
  try {
    // PanelAuth tidak menyediakan rename -> lakukan via koneksi users.db panel.
    // Gunakan metode internal yang ada: update langsung dilarang dari luar,
    // jadi kita tetap pakai username yang ada dan hanya info-kan.
    console.log(`[setup-owner] Nama login tetap '${owner.username}' (rename tidak didukung fase ini).`);
  } catch {
    /* noop */
  }
  void db;
}

try {
  const result = auth.bootstrapOwner({ username: owner.username, password });
  console.log(`
============================================================
  AKUN ADMIN BERHASIL DIBUAT
============================================================
  Username login : ${result.username}
  Password       : (yang barusan kamu ketik)
  2FA            : TOTP (lihat secret di bawah)
------------------------------------------------------------
  TOTP SECRET (masukkan ke aplikasi authenticator):
  ${result.totpSecretBase32}

  Cara pakai (HP):
  1. Install "Google Authenticator" / "Microsoft Authenticator"
  2. Tambah akun baru -> pilih "Enter a setup key" / "masukkan kunci"
  3. Paste secret di atas -> simpan
  4. Aplikasi menampilkan 6 angka yang berganti tiap 30 detik
     -> itulah "2FA code" saat login

  RECOVERY CODES (10 kode sekali pakai - simpan!):
${result.recoveryCodes.map((c) => `   - ${c}`).join('\n')}
    (Kode ini dipakai kalau HP hilang: isi di kolom 2FA
     sebagai pengganti angka authenticator, sekali pakai.)
============================================================
  Sekarang buka http://127.0.0.1:8080 dan login dengan:
  username + password di atas + 6 angka dari authenticator.
============================================================`);
} catch (e) {
  if (String(e?.message).includes('sudah pernah dilakukan')) {
    console.error('[setup-owner] Owner SUDAH pernah di-setup sebelumnya.');
    console.error('[setup-owner] Login langsung: username ' + owner.username + ' + password + kode 2FA.');
    console.error('[setup-owner] Lupa password? Hapus data/users.db lalu ulangi setup (data project TIDAK hilang, hanya akun panel).');
  } else {
    console.error(`[setup-owner] GAGAL: ${e?.message ?? e}`);
  }
  process.exit(1);
} finally {
  auth.close();
}
