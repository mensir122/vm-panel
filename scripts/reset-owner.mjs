// reset-owner.mjs — reset kredensial akun 'system' (sekali jalan).
// Menonaktifkan password + TOTP + recovery codes lama, agar setup-owner
// bisa dijalankan ulang. Data project TIDAK disentuh.
import { openDatabase } from '../lib/db.js';

const h = openDatabase('data/users.db', { schemaName: 'users' });
h.db.prepare(
  "UPDATE users SET totp_secret = NULL, password_hash = NULL, failed_attempts = 0, locked_until = NULL WHERE username = 'system'",
).run();
h.db.prepare(
  "DELETE FROM recovery_codes WHERE user_id = (SELECT id FROM users WHERE username = 'system')",
).run();
const check = h.db
  .prepare(
    "SELECT username, password_hash IS NOT NULL AS has_pass, totp_secret IS NOT NULL AS has_totp FROM users WHERE username = 'system'",
  )
  .get();
console.log(JSON.stringify(check));
h.close();
