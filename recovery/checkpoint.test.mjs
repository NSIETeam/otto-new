import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertExactSet, contentIdentity, safeRelative, verifyDigest } from './reconstruct-checkpoint.mjs';

test('only portable ordinary relative file paths are accepted', () => {
  assert.equal(safeRelative('src/enterprise/db.js'), 'src/enterprise/db.js');
  for (const value of ['../db.js', '/db.js', 'C:/db.js', 'src\\db.js', 'a//b', 'a/./b', 'a/../b', '', 'a\0b']) {
    assert.throws(() => safeRelative(value));
  }
});

test('file scope rejects missing, duplicate and extra paths', () => {
  assertExactSet(['b', 'a'], ['a', 'b'], 'scope');
  assert.throws(() => assertExactSet(['a'], ['a', 'b'], 'scope'));
  assert.throws(() => assertExactSet(['a', 'a'], ['a'], 'scope'));
  assert.throws(() => assertExactSet(['a', 'b'], ['a'], 'scope'));
});

test('content identity is sorted and binds each path and digest', () => {
  const one = '1'.repeat(64), two = '2'.repeat(64);
  assert.equal(contentIdentity({ b: two, a: one }), contentIdentity({ a: one, b: two }));
  assert.notEqual(contentIdentity({ a: one }), contentIdentity({ b: one }));
  assert.notEqual(contentIdentity({ a: one }), contentIdentity({ a: two }));
});

test('digest mismatch is fatal, with no override', () => {
  verifyDigest(Buffer.from(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty');
  assert.throws(() => verifyDigest(Buffer.from('x'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty'));
});
