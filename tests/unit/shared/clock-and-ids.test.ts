import { expect, test } from 'bun:test';
import { UuidV7Generator } from '../../../src/shared/ids/id-generator';
import { SystemClock } from '../../../src/shared/time/clock';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('UuidV7Generator yields unique, time-ordered UUIDv7 values', () => {
  const ids = new UuidV7Generator();
  const values = Array.from({ length: 1000 }, () => ids.next());
  for (const value of values) expect(value).toMatch(UUID_V7);
  expect(new Set(values).size).toBe(values.length);
  expect([...values].sort()).toEqual(values);
});

test('SystemClock returns the current time', () => {
  const before = Date.now();
  const now = new SystemClock().now().getTime();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
});
