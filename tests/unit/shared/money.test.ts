import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/shared/money/money.errors';
import { Money } from '../../../src/shared/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof InvalidMoneyError ? error.code : 'OTHER_ERROR';
  }
  return undefined;
}

describe('Money.from', () => {
  test('round-trips a valid amount unchanged', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('accepts zero and the largest NUMERIC(19,2) value', () => {
    expect(brl('0.00').toJSON().amount).toBe('0.00');
    expect(brl('99999999999999999.99').toJSON().amount).toBe('99999999999999999.99');
  });

  test.each(['25.5', '25', '10.555'])('rejects %p with INVALID_AMOUNT_SCALE', (amount) => {
    expect(codeOf(() => brl(amount))).toBe('INVALID_AMOUNT_SCALE');
  });

  test.each([
    '25,00',
    ' 25.00 ',
    '-1.00',
    '1e3',
    'NaN',
    'Infinity',
    '',
    '01.00',
    '.50',
    '1.',
    '+1.00',
  ])('rejects %p with INVALID_AMOUNT_FORMAT', (amount) => {
    expect(codeOf(() => brl(amount))).toBe('INVALID_AMOUNT_FORMAT');
  });

  test('rejects more than 17 integer digits with INVALID_AMOUNT_FORMAT', () => {
    expect(codeOf(() => brl('100000000000000000.00'))).toBe('INVALID_AMOUNT_FORMAT');
  });

  test('rejects a JSON number instead of a decimal string', () => {
    expect(codeOf(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' }))).toBe(
      'INVALID_AMOUNT_FORMAT',
    );
  });

  test.each(['brl', 'BR', 'BRLX', ''])('rejects currency %p with INVALID_CURRENCY', (currency) => {
    expect(codeOf(() => Money.from({ amount: '1.00', currency }))).toBe('INVALID_CURRENCY');
  });
});

describe('Money arithmetic', () => {
  test('adds exactly where binary floating point would not', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('subtracts into a negative result without rounding', () => {
    const result = brl('20.00').subtract(brl('80.00'));
    expect(result.toJSON().amount).toBe('-60.00');
    expect(result.isNegative()).toBe(true);
  });

  test('adds beyond the storage limit without losing precision (the limit belongs to the DB)', () => {
    expect(brl('99999999999999999.99').add(brl('0.01')).toJSON().amount).toBe(
      '100000000000000000.00',
    );
  });

  test('negates, and never prints negative zero', () => {
    expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).toJSON().amount).toBe('0.00');
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
  });

  test('rejects mixing currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money queries and formatting', () => {
  test('classifies sign', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
  });

  test('a negated zero is zero, not negative', () => {
    const negatedZero = Money.zero('BRL').negate();
    expect(negatedZero.isZero()).toBe(true);
    expect(negatedZero.isNegative()).toBe(false);
  });

  test('compares values', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.00').equals(brl('80.00'))).toBe(true);
    expect(brl('80.00').equals(Money.from({ amount: '80.00', currency: 'USD' }))).toBe(false);
  });

  test('formats as "<amount> <currency>"', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
    expect(brl('25.00').currency).toBe('BRL');
  });

  test('zero rejects an invalid currency', () => {
    expect(codeOf(() => Money.zero('xx'))).toBe('INVALID_CURRENCY');
  });

  test('serializes as a string amount inside JSON, never a number', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });
});
