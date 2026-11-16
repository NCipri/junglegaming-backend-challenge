import { expect, test } from 'bun:test';
import { canonicalJson, sha256Hex } from '../../../src/shared/hashing/canonical-json';

test('sorts object keys recursively and removes whitespace', () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
});

test('omits null and undefined object members', () => {
  expect(canonicalJson({ a: null, b: undefined, c: 'x' })).toBe(canonicalJson({ c: 'x' }));
  expect(canonicalJson({ a: null })).toBe('{}');
});

test('keeps array order', () => {
  expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
});

test('rejects non-finite numbers instead of serializing them as null', () => {
  expect(() => canonicalJson({ a: Number.NaN })).toThrow();
});

test('hashes with SHA-256 as lowercase hex', () => {
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
