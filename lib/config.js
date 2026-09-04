// lib/config.js — config loader VM-Panel (docs/DESIGN.md §2.5, Lampiran A).
// Parser YAML minimal bawaan TANPA dependency eksternal — cukup untuk
// config.yaml project ini:
//   - komentar full-line `#` dan inline ` #` (di luar quote)
//   - nested block berdasarkan indentasi spasi (beberapa level)
//   - scalar: angka, bool, null (~), string (quoted/plain)
//   - list inline `[a, b, c]`
// Key snake_case dikonversi ke camelCase (api_port → apiPort).
// Key yang hilang → fallback DEFAULTS (deep merge; parsed menang).
// Env override: VPANEL_ROOT (root project, dipakai bila rootDir tidak
// diberikan), MANAGER_API_PORT → manager.apiPort, PANEL_PORT → panel.port,
// VM_PANEL_ENV → cfg.env.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Nilai default (mencerminkan config.yaml project). Frozen — jangan diubah. */
export const DEFAULTS = deepFreeze({
  manager: { apiPort: 8097, hostMode: 'dev' },
  ports: { range: [10000, 65535], reserved: [22, 80, 443, 8080, 8097] },
  supervisor: {
    pollIntervalSec: 5,
    backoffSeq: [5, 15, 30, 60, 120],
    maxRestarts: 5,
    stableWindowSec: 600,
  },
  health: { defaultIntervalSec: 30 },
  backup: { intervalHours: 6, retention: { latest: 3, daily: 7, weekly: 4 } },
  storage: { warnPct: 20, critPct: 10, maxBackupSizeMb: 2048 },
  panel: { port: 8080, sessionTtlMin: 480 },
  worker: { pool: 4, queueCap: 32 },
  runner: { mode: 'off', jobMinutesBudget: 300, drainMinutes: 15 },
  tunnel: { provider: 'none' },
  env: 'dev',
});

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

function deepFreeze(node) {
  if (Array.isArray(node)) {
    node.forEach(deepFreeze);
    return Object.freeze(node);
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) deepFreeze(v);
    return Object.freeze(node);
  }
  return node;
}

function snakeToCamel(key) {
  return String(key).replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

/** Deep merge: `over` menimpa `base`; array ditimpa utuh; undefined → base. */
function deepMerge(base, over) {
  if (over === undefined) return base;
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const out =
    base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

/** Env var integer (strict) → number, atau null bila tidak ada/tidak valid. */
function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// parser YAML minimal
// ---------------------------------------------------------------------------

/** Buang inline comment di luar quote, lalu trim. */
function stripInlineComment(s) {
  let inQ = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ !== null) {
      if (ch === inQ) inQ = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQ = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return s.slice(0, i).trim();
    }
  }
  return s.trim();
}

/** Parse list inline `[a, b]` — item angka/quoted-string. */
function parseInlineList(s) {
  const inner = s.slice(1, -1);
  const items = [];
  let cur = '';
  let inQ = null;
  for (const ch of inner) {
    if (inQ !== null) {
      cur += ch;
      if (ch === inQ) inQ = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQ = ch;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      items.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  items.push(cur);
  return items
    .filter((x) => x.trim() !== '')
    .map((x) => parseValue(x));
}

/** Parse scalar: list / quoted / bool / null / int / float / plain string. */
export function parseValue(raw) {
  const s = String(raw).trim();
  if (s === '') return null;
  if (s.startsWith('[') && s.endsWith(']')) return parseInlineList(s);
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^[+-]?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)$/.test(s)) return Number.parseFloat(s);
  return s;
}

/**
 * Parser YAML minimal: nested block via indentasi (beberapa level), komentar,
 * scalar, list inline. Baris tanpa ':' dan level > 1 langsung diabaikan.
 * Block kosong (`key:` tanpa anak) → null.
 */
export function parseYamlSimple(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  const pendingBlocks = []; // {parent, key, child} — block kosong → null
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue; // parser minimal: abaikan baris non key: value
    let key = trimmed.slice(0, colonIdx).trim().replace(/^["']|["']$/g, '');
    if (key === '') continue;
    key = snakeToCamel(key);
    const restRaw = trimmed.slice(colonIdx + 1);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const rest = stripInlineComment(restRaw);
    if (rest === '') {
      const child = {};
      parent[key] = child;
      pendingBlocks.push({ parent, key, child });
      stack.push({ indent, obj: child });
    } else {
      parent[key] = parseValue(rest);
    }
  }
  for (const { parent, key, child } of pendingBlocks) {
    if (Object.keys(child).length === 0) parent[key] = null;
  }
  return root;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Baca `config.yaml` dari rootDir (fallback: env VPANEL_ROOT, lalu cwd),
 * merge ke atas DEFAULTS (key hilang → default), lalu terapkan env override.
 * File tidak ada → seluruh default dipakai (tidak throw).
 * Output selalu object baru (tidak memutasi DEFAULTS).
 * @param {{rootDir?: string}} [opts]
 */
export function loadConfig({ rootDir } = {}) {
  const envRoot =
    process.env.VPANEL_ROOT && String(process.env.VPANEL_ROOT).trim() !== ''
      ? String(process.env.VPANEL_ROOT)
      : null;
  const root = rootDir ?? envRoot ?? process.cwd();
  const file = join(root, 'config.yaml');

  let parsed = {};
  if (existsSync(file)) {
    parsed = parseYamlSimple(readFileSync(file, 'utf8'));
  }

  const cfg = deepMerge(structuredClone(DEFAULTS), parsed);

  // Env override
  const envApiPort = envInt('MANAGER_API_PORT');
  if (envApiPort !== null) cfg.manager.apiPort = envApiPort;
  const envPanelPort = envInt('PANEL_PORT');
  if (envPanelPort !== null) cfg.panel.port = envPanelPort;
  const envMode = process.env.VM_PANEL_ENV;
  if (envMode !== undefined && String(envMode).trim() !== '') {
    cfg.env = String(envMode).trim();
  }

  // Metadata resolve (ekstra di luar config.yaml, untuk konsumen)
  cfg.rootDir = root;
  return cfg;
}
