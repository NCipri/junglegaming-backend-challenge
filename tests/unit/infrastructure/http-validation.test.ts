import { describe, expect, test } from 'bun:test';
import { HttpProblem } from '../../../src/infrastructure/http/http-problem';
import { parseIdempotencyKey } from '../../../src/infrastructure/http/validation';

function codeOf(value: string | undefined): string {
  try {
    parseIdempotencyKey(value);
  } catch (error) {
    return (error as HttpProblem).code;
  }

  return 'OK';
}

describe('Idempotency-Key validation', () => {
  test.each([
    [undefined, 'IDEMPOTENCY_KEY_MISSING'],
    ['', 'IDEMPOTENCY_KEY_MISSING'],
    ['   ', 'IDEMPOTENCY_KEY_MISSING'],
    [' key', 'INVALID_PAYLOAD'],
    ['key ', 'INVALID_PAYLOAD'],
    ['k'.repeat(256), 'INVALID_PAYLOAD'],
    ['chave-ç', 'INVALID_PAYLOAD'],
    ['a\tb', 'INVALID_PAYLOAD'],
    ['k', 'OK'],
    ['provider-a:tx 123', 'OK'],
    ['k'.repeat(255), 'OK'],
  ])('%p → %s', (value, expected) => {
    expect(codeOf(value)).toBe(expected);
  });
});
