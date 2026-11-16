// Domain errors raised by the Money value object.
import { DomainError } from '../errors/domain-error';

export type InvalidMoneyCode =
  'INVALID_AMOUNT_FORMAT' | 'INVALID_AMOUNT_SCALE' | 'INVALID_CURRENCY';

export class InvalidMoneyError extends DomainError {
  constructor(
    readonly code: InvalidMoneyCode,
    detail: string,
  ) {
    super(detail);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
