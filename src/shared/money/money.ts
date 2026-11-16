// Money value object: exact decimal amounts, scale 2, immutable, currency-safe.
import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const Exact = Decimal.clone({ precision: 40, toExpNeg: -40, toExpPos: 40 });

const VALID_AMOUNT = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const WRONG_SCALE = /^(0|[1-9]\d*)(\.\d+)?$/;
const TWO_DECIMALS = /\.\d{2}$/;
const VALID_CURRENCY = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    Money.assertCurrency(props.currency);
    const { amount } = props;

    if (typeof amount !== 'string' || !VALID_AMOUNT.test(amount)) {
      const scaleOnly =
        typeof amount === 'string' && WRONG_SCALE.test(amount) && !TWO_DECIMALS.test(amount);

      throw new InvalidMoneyError(
        scaleOnly ? 'INVALID_AMOUNT_SCALE' : 'INVALID_AMOUNT_FORMAT',
        `Invalid amount: expected a decimal string with exactly 2 decimals`,
      );
    }

    return new Money(new Exact(amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);

    return new Money(new Exact(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !VALID_CURRENCY.test(currency)) {
      throw new InvalidMoneyError('INVALID_CURRENCY', 'Invalid currency: expected ISO-4217 code');
    }
  }
}
