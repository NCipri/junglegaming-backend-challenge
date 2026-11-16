import { describe, expect, test } from 'bun:test';
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
} from '../../../src/modules/wallet/application/ledger-cursor';

describe('ledger cursor', () => {
  test('round-trips a wallet version through an opaque base64url string', () => {
    for (const version of [1, 2, 50, 123_456]) {
      const cursor = encodeCursor(version);

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(cursor)).toBe(version);
    }
  });

  test.each([
    '!!',
    '',
    'bm9wZQ',
    encodeCursor(1).slice(0, -1) + '*',
    Buffer.from('v:0').toString('base64url'),
    Buffer.from('v:-3').toString('base64url'),
    Buffer.from('v:1.5').toString('base64url'),
  ])('%p is rejected with INVALID_CURSOR', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
    try {
      decodeCursor(cursor);
    } catch (error) {
      expect((error as InvalidCursorError).code).toBe('INVALID_CURSOR');
    }
  });
});
