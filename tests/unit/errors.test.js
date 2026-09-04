// tests/unit/errors.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VmPanelError,
  isVmPanelError,
  CODES,
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
} from '../../lib/errors.js';

test('VmPanelError: extends Error, membawa code & details', () => {
  const err = new VmPanelError(LOCK_HELD, 'lock dipegang proses lain', { name: 'backup-global' });
  assert.ok(err instanceof Error);
  assert.ok(err instanceof VmPanelError);
  assert.equal(err.name, 'VmPanelError');
  assert.equal(err.code, LOCK_HELD);
  assert.deepEqual(err.details, { name: 'backup-global' });
  assert.equal(err.message, 'lock dipegang proses lain');
  assert.equal(typeof err.stack, 'string');
});

test('VmPanelError: details default undefined', () => {
  const err = new VmPanelError(VALIDATION, 'bad input');
  assert.equal(err.details, undefined);
});

test('isVmPanelError: true hanya untuk VmPanelError', () => {
  assert.equal(isVmPanelError(new VmPanelError(NOT_FOUND, 'x')), true);
  assert.equal(isVmPanelError(new Error('x')), false);
  assert.equal(isVmPanelError(null), false);
});

test('semua 15 kode sistem terdaftar di CODES', () => {
  const expected = [
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
  ];
  assert.equal(Object.keys(CODES).length, 15);
  for (const c of expected) {
    assert.equal(typeof c, 'string');
    assert.equal(CODES[c], c);
  }
});

test('CODES frozen dan toJSON aman-log', () => {
  assert.equal(Object.isFrozen(CODES), true);
  const err = new VmPanelError(PORT_IN_USE, 'port terpakai', { port: 8080 });
  const json = err.toJSON();
  assert.deepEqual(json, {
    name: 'VmPanelError',
    code: PORT_IN_USE,
    message: 'port terpakai',
    details: { port: 8080 },
  });
  assert.equal(json.stack, undefined);
});
