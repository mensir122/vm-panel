// manager/adapters/index.js — registry adapter (DESIGN.md §2.6).
// Pemakaian: createAdapter('static', { workspacePath, config }) → instance adapter.

import { VmPanelError, VALIDATION } from '../../lib/errors.js';
import { StaticAdapter } from './static-adapter.js';
import { NodeAdapter } from './node-adapter.js';
import { PythonAdapter } from './python-adapter.js';

/** Registry tipe adapter → class. */
export const ADAPTERS = Object.freeze({
  static: StaticAdapter,
  node: NodeAdapter,
  python: PythonAdapter,
});

/**
 * Buat instance adapter berdasar tipe.
 * @param {keyof typeof ADAPTERS} type
 * @param {{workspacePath?: string, config?: object}} [opts]
 * @returns {import('./base.js').BaseAdapter}
 */
export function createAdapter(type, opts = {}) {
  const Cls = ADAPTERS[type];
  if (typeof Cls !== 'function') {
    throw new VmPanelError(VALIDATION, `tipe adapter tidak dikenal: ${String(type)}`, {
      type,
      known: Object.keys(ADAPTERS),
    });
  }
  return new Cls(opts);
}
