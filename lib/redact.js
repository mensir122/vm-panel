// lib/redact.js — redaction pipeline (DESIGN.md §13.2).
// Wajib dijalankan sebelum menulis log/audit/error.
// Format yang ditangani (case-insensitive):
//   1. <nama>: <nilai>            (plain, termasuk "Authorization: Bearer xyz")
//   2. <nama>":"<nilai>           (JSON style)
//   3. bearer <nilai>             (space-separated scheme)
//   4. <nama>=<nilai>             (gaya env/query-string — F14; HANYA nama key
//      sensitif dari KEY_PATTERN yang kena, boundary \b utuh sehingga
//      'session_id=' / 'num_tokens=' TIDAK ikut tereduksi — anti over-redact)
//   5. extraValues — nilai secret aktif, exact-match, di mana pun posisinya

const KEY_PATTERN =
  '(?:token|password|passwd|api[_-]?key|secret|private[_-]?key|session|otp|cookie|authorization|bearer)';

// "nama" : "nilai"  — JSON
const JSON_RE = new RegExp(`"(${KEY_PATTERN})"\\s*:\\s*"[^"]*"`, 'gi');
// nama: nilai — plain; nilai = sisa baris sampai delimiter (",", ";", "}", quote)
// (over-redact aman; mencegah kebocoran seperti "Basic dXNlcjpwYXNz")
const PLAIN_RE = new RegExp(`\\b(${KEY_PATTERN})\\b\\s*:\\s*[^\\r\\n,;}"][^\\r\\n,;}]*`, 'gi');
// bearer <nilai> — satu token setelah scheme
const BEARER_RE = new RegExp(`\\b(bearer)\\s+([^\\s"']+)`, 'gi');
// nama=nilai — gaya env/query-string (F14). Group 2 = spasi di sekitar '='
// dipertahankan apa adanya. Nilai = sisa sampai delimiter (",", ";", "&",
// newline) — sama seperti PLAIN_RE: over-redact dianggap aman, Bocor tidak.
// Berhenti di '&' menjaga query-string `?a=1&token=x&b=2` agar 'b=2' tak ikut.
const KEY_VALUE_RE = new RegExp(`\\b(${KEY_PATTERN})\\b(\\s*=\\s*)[^\\r\\n,;&]+`, 'gi');

const KEY_MATCH = new RegExp(`^${KEY_PATTERN}$`, 'i');

export const REDACTED_VALUE = '***REDACTED***';
export const MAX_STRING_LENGTH = 8192;

function redactString(input, extras) {
  let s = input;
  // 1) extraValues duluan — nilai secret aktif harus hilang walau bentuknya
  //    tidak cocok pola umum. Exact-match, escape regex via split/join.
  for (const v of extras) {
    if (s.includes(v)) s = s.split(v).join(REDACTED_VALUE);
  }
  // 2) JSON: "token":"..."
  s = s.replace(JSON_RE, (_m, k) => `"${k}":"${REDACTED_VALUE}"`);
  // 3) plain: token: ...
  s = s.replace(PLAIN_RE, (_m, k) => `${k}: ${REDACTED_VALUE}`);
  // 4) bearer <token>
  s = s.replace(BEARER_RE, (_m, k) => `${k} ${REDACTED_VALUE}`);
  // 5) F14: token=abc123 / password = "x" (gaya env & query-string)
  s = s.replace(KEY_VALUE_RE, (_m, k, eq) => `${k}${eq}${REDACTED_VALUE}`);
  return s.length > MAX_STRING_LENGTH ? s.slice(0, MAX_STRING_LENGTH) : s;
}

/**
 * Buat fungsi redact(input) dengan konfigurasi tetap.
 * @param {{extraValues?: Set<string>|Iterable<string>}} [opts]
 * @returns {(input: any) => any} redact — string direduksi; object/array
 *          di-deep-walk (key sensitif -> nilai seluruhnya direduksi); tipe
 *          lain lewat apa adanya.
 */
export function makeRedactor({ extraValues } = {}) {
  const extras = new Set();
  if (extraValues) {
    for (const v of extraValues) {
      if (typeof v === 'string' && v.length > 0) extras.add(v);
    }
  }

  const walk = (node, depth) => {
    if (depth > 32) return '[max-depth]';
    if (typeof node === 'string') return redactString(node, extras);
    if (Array.isArray(node)) return node.map((x) => walk(x, depth + 1));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = KEY_MATCH.test(k) ? REDACTED_VALUE : walk(v, depth + 1);
      }
      return out;
    }
    return node;
  };

  return function redact(input) {
    return walk(input, 0);
  };
}

/** Redactor default (tanpa extraValues) untuk pemakaian cepat. */
export const redact = makeRedactor();
