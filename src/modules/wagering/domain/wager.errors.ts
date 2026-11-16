// Domain errors raised by the WagerTransaction state machine and its factory.
import { DomainError } from '../../../shared/errors/domain-error';

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(detail: string) {
    super(`Invalid transaction state: ${detail}`);
  }
}

export type InvalidWagerAmountCode = 'INVALID_AMOUNT_ZERO' | 'INVALID_AMOUNT_FORMAT';

export class InvalidWagerAmountError extends DomainError {
  constructor(
    readonly code: InvalidWagerAmountCode,
    detail: string,
  ) {
    super(detail);
  }
}
