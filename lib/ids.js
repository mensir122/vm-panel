// lib/ids.js — generator ID (Lampiran A: `prj_` + 10 char base32 Crockford).
// Alphabet Crockford base32: tanpa I, L, O, U agar tidak tertukar saat dibaca/diketik.

import { randomBytes } from 'node:crypto';

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ID_LENGTH = 10;

/**
 * Generator ID crypto-secure: `${prefix}_` + 10 karakter Crockford base32.
 * Prefix boleh ditulis dengan atau tanpa trailing underscore:
 *   genId('prj')  -> 'prj_A1B2C3D4E5F'
 *   genId('prj_') -> 'prj_A1B2C3D4E5F'
 * Prefix yang dikenal sistem: prj_, svc_, dep_, bak_, usr_, ses_.
 * @param {string} prefix
 * @returns {string}
 */
export function genId(prefix = '') {
  const clean = String(prefix).replace(/_+$/, '');
  const bytes = randomBytes(ID_LENGTH);
  let out = '';
  // 256 % 32 === 0 -> modulo tanpa bias.
  for (let i = 0; i < ID_LENGTH; i++) out += ALPHABET[bytes[i] % 32];
  return clean ? `${clean}_${out}` : out;
}

/** Cek validitas format ID: optional prefix + 10 char Crockford base32. */
export function isValidId(id, prefix = '') {
  const clean = String(prefix).replace(/_+$/, '');
  const re = clean
    ? new RegExp(`^${clean}_[${ALPHABET}]{${ID_LENGTH}}$`)
    : new RegExp(`^[${ALPHABET}]{${ID_LENGTH}}$`);
  return re.test(String(id));
}
