// lib/errors.js — error terstruktur + kode error sistem (docs/DESIGN.md).

/** Kode error kanonik VM-Panel. Selalu string SCREAMING_SNAKE_CASE. */
export const PORT_ILLEGAL = 'PORT_ILLEGAL';
export const PORT_IN_USE = 'PORT_IN_USE';
export const DEPLOY_IN_PROGRESS = 'DEPLOY_IN_PROGRESS';
export const BACKUP_IN_PROGRESS = 'BACKUP_IN_PROGRESS';
export const QUEUE_FULL = 'QUEUE_FULL';
export const LOCK_HELD = 'LOCK_HELD';
export const PATH_ESCAPE = 'PATH_ESCAPE';
export const INVALID_PROJECT_ID = 'INVALID_PROJECT_ID';
export const INVALID_NAME = 'INVALID_NAME';
export const REFUSE_START_DB = 'REFUSE_START_DB';
export const SECRET_NOT_FOUND = 'SECRET_NOT_FOUND';
export const PERMISSION_DENIED = 'PERMISSION_DENIED';
export const NOT_FOUND = 'NOT_FOUND';
export const VALIDATION = 'VALIDATION';
export const UNSUPPORTED_PLATFORM = 'UNSUPPORTED_PLATFORM';

/** Semua kode dalam satu object (untuk iterasi/validasi). */
export const CODES = Object.freeze({
  PORT_ILLEGAL,
  PORT_IN_USE,
  DEPLOY_IN_PROGRESS,
  BACKUP_IN_PROGRESS,
  QUEUE_FULL,
  LOCK_HELD,
  PATH_ESCAPE,
  INVALID_PROJECT_ID,
  INVALID_NAME,
  REFUSE_START_DB,
  SECRET_NOT_FOUND,
  PERMISSION_DENIED,
  NOT_FOUND,
  VALIDATION,
  UNSUPPORTED_PLATFORM,
});

/**
 * Error dasar VM-Panel: membawa {code, details} selain message.
 * Contoh: throw new VmPanelError(LOCK_HELD, 'lock dipegang proses lain', { name });
 */
export class VmPanelError extends Error {
  /** @param {string} code salah satu konstanta kode di atas */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'VmPanelError';
    this.code = code;
    this.details = details;
  }

  /** Bentuk aman-log (tanpa stack, siap redaksi). */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/** Type guard ringan. */
export function isVmPanelError(err) {
  return err instanceof VmPanelError;
}
