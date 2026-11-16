import { expect, test } from 'bun:test';
import { computeBackoff } from '../../../src/shared/time/backoff';

const outbox = { baseMs: 1000, capMs: 300_000 };

test('grows exponentially from the attempts made so far', () => {
  expect(computeBackoff({ ...outbox, attempts: 0, random: () => 0.5 })).toBe(1000);
  expect(computeBackoff({ ...outbox, attempts: 3, random: () => 0.5 })).toBe(8000);
});

test('applies a jitter between 0.8 and 1.2', () => {
  expect(computeBackoff({ ...outbox, attempts: 3, random: () => 0 })).toBe(6400);
  expect(computeBackoff({ ...outbox, attempts: 3, random: () => 1 })).toBe(9600);
});

test('never exceeds the cap, even with the highest jitter', () => {
  expect(computeBackoff({ ...outbox, attempts: 20, random: () => 1 })).toBe(300_000);
  expect(computeBackoff({ ...outbox, attempts: 5000, random: () => 1 })).toBe(300_000);
});

test('returns whole milliseconds', () => {
  expect(Number.isInteger(computeBackoff({ ...outbox, attempts: 1, random: () => 0.123 }))).toBe(
    true,
  );
});
