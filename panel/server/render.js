// panel/server/render.js — mesin template minimal panel (docs/DESIGN.md §15).
// renderTemplate(templateName, vars, {templatesDir}) → string HTML:
//   - baca <templatesDir>/<templateName>.html (default: panel/templates/)
//   - {{key}}      → escapeHtml(String(vars[key] ?? ''))
//   - {{key|raw}}  → String(vars[key] ?? '') TANPA escape
//   - placeholder tak dikenal (key tidak ada di vars) → dibiarkan apa adanya
//     (mudah didebug saat desainer menambah key baru)
// Cache isi file per process dengan mtime check (edit template → otomatis
// terbaca ulang tanpa restart). escapeHtml diekspor untuk pemakaian fallback.

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VmPanelError, NOT_FOUND, VALIDATION } from '../../lib/errors.js';

/** Direktori template default: panel/templates/ (relatif terhadap file ini). */
const DEFAULT_TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
);

/** Cache per process: Map<absPath, {mtimeMs, html}> — invalidasi via mtime. */
const cache = new Map();

/** Escape HTML entity: & < > " ' (urutan & lebih dulu agar tidak double-escape). */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Placeholder: {{key}} atau {{key|raw}}. Key: [A-Za-z0-9_-].
 * Group 2 ada → mode raw (tanpa escape).
 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_-]+)\s*(\|\s*raw)?\s*\}\}/g;

/** Terapkan vars ke isi template sesuai kontrak {{key}} / {{key|raw}}. */
function applyVars(html, vars) {
  return html.replace(PLACEHOLDER_RE, (match, key, rawFlag) => {
    if (!vars || typeof vars !== 'object' || !Object.prototype.hasOwnProperty.call(vars, key)) {
      return match; // tak dikenal → biarkan (mudah didebug)
    }
    const value = vars[key] === undefined || vars[key] === null ? '' : String(vars[key]);
    return rawFlag ? value : escapeHtml(value);
  });
}

/** Baca template dengan cache mtime; file hilang → VmPanelError NOT_FOUND. */
function loadTemplate(file) {
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    throw new VmPanelError(NOT_FOUND, `renderTemplate: template tidak ditemukan: ${file}`);
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.html;
  const html = readFileSync(file, 'utf8');
  cache.set(file, { mtimeMs, html });
  return html;
}

/**
 * Render template menjadi string HTML.
 * @param {string} templateName nama file tanpa ekstensi (tanpa '/'/'\\'/'..')
 * @param {Record<string, unknown>} vars key → nilai (flat)
 * @param {{templatesDir?: string}} [opts] override direktori template (untuk test)
 * @returns {string} HTML
 */
export function renderTemplate(templateName, vars = {}, opts = {}) {
  if (
    typeof templateName !== 'string' ||
    templateName === '' ||
    templateName.includes('/') ||
    templateName.includes('\\') ||
    templateName.includes('..')
  ) {
    throw new VmPanelError(
      VALIDATION,
      `renderTemplate: nama template tidak valid: ${String(templateName)}`,
    );
  }
  const dir = opts.templatesDir ? resolve(opts.templatesDir) : DEFAULT_TEMPLATES_DIR;
  const file = join(dir, `${templateName}.html`);
  return applyVars(loadTemplate(file), vars);
}
