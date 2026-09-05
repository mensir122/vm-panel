// verify-totp-decrypt.mjs — verifikasi TOTP secret terdekripsi dengan kunci .env
import fs from 'node:fs';
import { PanelAuth } from '../panel/server/auth.js';
import { deriveKeys, aesDecrypt } from '../lib/crypto.js';
import { openDatabase } from '../lib/db.js';
import { loadDotEnv } from '../lib/env.js';

const ROOT = process.cwd();
loadDotEnv(ROOT);

const auth = new PanelAuth({ dataDir: ROOT + '/data' });
const h = openDatabase(ROOT + '/data/users.db', { schemaName: 'users' });
const row = h.db.prepare("SELECT id, totp_secret FROM users WHERE username = 'system'").get();
const salt = h.db.prepare("SELECT value FROM meta WHERE key = 'panel_key_salt'").get()?.value;
const master = process.env.VPANEL_MASTER_KEY;

if (!row?.totp_secret) {
  console.log('TOTP secret: TIDAK ADA (belum bootstrap)');
} else if (!master) {
  console.log('VPANEL_MASTER_KEY: TIDAK ADA di .env');
} else {
  const kEnc = deriveKeys(master, salt).kEnc;
  try {
    const env = JSON.parse(row.totp_secret);
    const decrypted = aesDecrypt(kEnc, env).toString('utf8');
    const isBase32 = /^[A-Z2-7]+=*$/.test(decrypted) && decrypted.length >= 32;
    console.log(
      isBase32
        ? 'TOTP secret decrypt dengan kunci .env: BERHASIL (valid base32) — panel fix akan bisa login'
        : `GAGAL: hasil tak dikenali (${JSON.stringify(decrypted).slice(0, 50)})`,
    );
  } catch (e) {
    console.log(`GAGAL dekripsi: ${e.message} — secret lama terenkripsi dengan kunci lain`);
  }
}
auth.close();
h.close();
