// tests/unit/ids.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genId, isValidId, ALPHABET } from '../../lib/ids.js';

test('genId: format prj_ + 10 char Crockford base32', () => {
  const id = genId('prj');
  assert.match(id, /^prj_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
  assert.equal(id.length, 'prj_'.length + 10);
});

test('genId: prefix trailing underscore opsional & konsisten', () => {
  assert.equal(genId('prj').startsWith('prj_'), true);
  assert.equal(genId('prj_').startsWith('prj_'), true);
  assert.equal(genId('svc').startsWith('svc_'), true);
  assert.equal(genId('dep').startsWith('dep_'), true);
  assert.equal(genId('bak').startsWith('bak_'), true);
  assert.equal(genId('usr').startsWith('usr_'), true);
  assert.equal(genId('ses').startsWith('ses_'), true);
});

test('genId: hanya karakter alphabet Crockford (tanpa I/L/O/U)', () => {
  for (let i = 0; i < 200; i++) {
    const id = genId('svc');
    for (const ch of id.slice('svc_'.length)) {
      assert.ok(ALPHABET.includes(ch), `karakter ilegal: ${ch} di ${id}`);
    }
  }
});

test('genId: crypto-secure — tidak menghasilkan duplikat dalam volume besar', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(genId('dep'));
  assert.equal(seen.size, 5000);
});

test('genId: dua pemanggilan berturut-turut hampir pasti berbeda', () => {
  assert.notEqual(genId('bak'), genId('bak'));
});

test('isValidId: terima id benar, tolak salah panjang/karakter/prefix', () => {
  assert.equal(isValidId('prj_ABCDEFGHIJ', 'prj'), false); // I ilegal di Crockford base32
  assert.equal(isValidId(genId('prj'), 'prj'), true);
  assert.equal(isValidId(genId('ses'), 'ses'), true);
  assert.equal(isValidId(genId('prj'), 'svc'), false);
  assert.equal(isValidId(genId('prj').slice(0, -1), 'prj'), false); // 9 char
  assert.equal(isValidId('prj_ABCDEFGHIO', 'prj'), false); // O & I ilegal
});
