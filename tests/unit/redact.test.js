// tests/unit/redact.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRedactor, redact, REDACTED_VALUE, MAX_STRING_LENGTH } from '../../lib/redact.js';

const R = REDACTED_VALUE;

test('pattern <nama>: <nilai> — token, password, api_key, secret, dst.', () => {
  assert.equal(redact('token: abc123'), `token: ${R}`);
  assert.equal(redact('password: hunter2!'), `password: ${R}`);
  assert.equal(redact('passwd: p@ss'), `passwd: ${R}`);
  assert.equal(redact('api_key: AKIA123'), `api_key: ${R}`);
  assert.equal(redact('api-key: AKIA123'), `api-key: ${R}`);
  assert.equal(redact('apiKey: AKIA123'), `apiKey: ${R}`);
  assert.equal(redact('secret: topsecret'), `secret: ${R}`);
  assert.equal(redact('private_key: MIIEpA'), `private_key: ${R}`);
  assert.equal(redact('private-key: MIIEpA'), `private-key: ${R}`);
  assert.equal(redact('session: s3cret'), `session: ${R}`);
  assert.equal(redact('otp: 123456'), `otp: ${R}`);
  assert.equal(redact('cookie: sid=xyz'), `cookie: ${R}`);
  assert.equal(redact('authorization: Basic dXNlcjpwYXNz'), `authorization: ${R}`);
});

test('case-insensitive', () => {
  assert.equal(redact('TOKEN: abc'), `TOKEN: ${R}`);
  assert.equal(redact('Password: abc'), `Password: ${R}`);
  assert.equal(redact('API_KEY: abc'), `API_KEY: ${R}`);
});

test('format JSON: <nama>":"<nilai>', () => {
  const json = '{"token":"abc123","user":"budi"}';
  const out = redact(json);
  assert.ok(out.includes('"user":"budi"'));
  assert.ok(out.includes('"token":"***REDACTED***"'), out);
  assert.ok(!out.includes('abc123'));
});

test('bearer <nilai> direduksi', () => {
  // "Bearer xyz" sebagai scheme tersendiri -> token direduksi, scheme dipertahankan
  assert.equal(redact('bearer eyJhbGc.abc.def tail'), `bearer ${R} tail`);
  // "Authorization: Bearer xyz" -> over-redaction: seluruh nilai setelah "authorization:" hilang
  assert.equal(redact('Authorization: Bearer eyJhbGc.abc.def'), `Authorization: ${R}`);
});

test('nilai aman TIDAK ikut tereduksi', () => {
  const out = redact('user: budi, port: 8080, host: localhost');
  assert.equal(out, 'user: budi, port: 8080, host: localhost');
});

test('object/array: deep-walk dan redact per string', () => {
  const input = {
    a: 'token: abc',
    b: { c: ['password: x', { d: 'secret: y' }] },
    e: 123,
    f: true,
  };
  const out = redact(input);
  assert.equal(out.a, `token: ${R}`);
  assert.equal(out.b.c[0], `password: ${R}`);
  assert.equal(out.b.c[1].d, `secret: ${R}`);
  assert.equal(out.e, 123);
  assert.equal(out.f, true);
});

test('object: key sensitif -> nilai seluruhnya direduksi', () => {
  const out = redact({ token: 'abc123', note: 'aman' });
  assert.equal(out.token, R);
  assert.equal(out.note, 'aman');
});

test('extraValues: exact-match diganti ***REDACTED*** di mana pun posisinya', () => {
  const rd = makeRedactor({ extraValues: new Set(['sv-X9supersecret', 'hunter2']) });
  assert.equal(
    rd('spawn dengan env FOO=sv-X9supersecret dan password: hunter2'),
    `spawn dengan env FOO=${R} dan password: ${R}`,
  );
  assert.equal(rd({ nested: ['x sv-X9supersecret y'] }).nested[0], `x ${R} y`);
  // nilai lain tidak terpengaruh
  assert.equal(rd('sv-X9supersec y'), 'sv-X9supersec y');
});

test('extraValues: escape regex — nilai dengan meta karakter tetap exact-match', () => {
  const rd = makeRedactor({ extraValues: new Set(['p@$$w0rd.*[x]+(y)']) });
  assert.equal(rd('key p@$$w0rd.*[x]+(y) ok'), `key ${R} ok`);
});

test('clamp: string hasil > 8192 char dipotong', () => {
  const long = 'x'.repeat(20_000);
  const out = redact(long);
  assert.equal(out.length, MAX_STRING_LENGTH);
});

test('makeRedactor: tanpa opts tetap bekerja (redactor default)', () => {
  assert.equal(makeRedactor()('token: z'), `token: ${R}`);
});

test('tipe non-string tidak diubah', () => {
  const input = { n: 42, b: false, nil: null, arr: [1, 2] };
  assert.deepEqual(redact(input), input);
});
