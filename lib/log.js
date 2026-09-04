// lib/log.js — logger terstruktur (satu baris JSON per entry, timestamp UTC ISO-8601).
// Semua string/extra dilewatkan redactor sebelum ditulis (DESIGN.md §13.2).

import fs from 'node:fs';
import path from 'node:path';
import { makeRedactor } from './redact.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function utcIso() {
  return new Date().toISOString(); // selalu UTC ("Z")
}

/**
 * @param {{dir: string, name: string, level?: 'debug'|'info'|'warn'|'error',
 *          redactor?: (input: any) => any, fields?: object}} opts
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: Function}}
 */
export function createLogger({ dir, name, level = 'info', redactor = makeRedactor(), fields = {} }) {
  if (!dir || !name) throw new TypeError('createLogger: dir dan name wajib');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.log`);
  const minLevel = LEVELS[level] ?? LEVELS.info;

  function write(levelName, msg, extra) {
    if ((LEVELS[levelName] ?? 0) < minLevel) return;
    // extra/fields tidak boleh menimpa metadata inti (ts/level/name/msg).
    const CORE = ['ts', 'level', 'name', 'msg'];
    let merged = { ...fields, ...(extra && typeof extra === 'object' ? extra : {}) };
    for (const k of CORE) delete merged[k];
    merged = redactor(merged);
    const entry = {
      ts: utcIso(),
      level: levelName,
      name,
      msg: redactor(String(msg)),
      ...merged,
    };
    let line;
    try {
      line = JSON.stringify(entry) + '\n';
    } catch {
      line = JSON.stringify({ ts: utcIso(), level: levelName, name, msg: '[unserializable extra]' }) + '\n';
    }
    // Tulis file gagal -> stderr saja, JANGAN throw (logging tidak boleh crash app).
    try {
      fs.appendFileSync(file, line);
    } catch (e) {
      process.stderr.write(`[log] write failed for ${file}: ${e?.message ?? e}\n${line}`);
    }
  }

  const logger = {
    debug: (msg, extra) => write('debug', msg, extra),
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
    /** Logger turunan dengan fields tambahan (menimpa fields induk bila bentrok). */
    child: (childFields = {}) =>
      createLogger({ dir, name, level, redactor, fields: { ...fields, ...childFields } }),
  };
  return logger;
}

export const LOG_LEVELS = LEVELS;
