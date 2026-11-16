import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { Money } from '../../../src/shared/money/money';

const MAX_CENTS = 9_999_999_999_999_999_999n;

const amount = fc.bigInt({ min: 0n, max: MAX_CENTS }).map((cents) => {
  const digits = cents.toString().padStart(3, '0');
  return Money.from({ amount: `${digits.slice(0, -2)}.${digits.slice(-2)}`, currency: 'BRL' });
});

const runs = { numRuns: 1000 };

test('adding then subtracting the same value returns the original', () => {
  fc.assert(
    fc.property(amount, amount, (a, b) => a.add(b).subtract(b).equals(a)),
    runs,
  );
});

test('addition is commutative', () => {
  fc.assert(
    fc.property(amount, amount, (a, b) => a.add(b).equals(b.add(a))),
    runs,
  );
});

test('serialized amounts always have exactly two decimals', () => {
  fc.assert(
    fc.property(amount, amount, (a, b) => {
      expect(a.subtract(b).toJSON().amount).toMatch(/^-?\d+\.\d{2}$/);
      expect(a.add(b).toJSON().amount).toMatch(/^\d+\.\d{2}$/);
    }),
    runs,
  );
});
