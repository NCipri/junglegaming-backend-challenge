// Domain errors raised by the Wallet aggregate and its ledger entries.
import { DomainError } from '../../../shared/errors/domain-error';

export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';

  constructor(walletId: string) {
    super(`Wallet ${walletId} has insufficient balance for this debit`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'LEDGER_UNBALANCED';

  constructor(detail: string) {
    super(`Invalid ledger entry: ${detail}`);
  }
}

export class InvalidWalletOpeningError extends DomainError {
  readonly code = 'INVALID_WALLET_OPENING';

  constructor(detail: string) {
    super(`Invalid wallet opening: ${detail}`);
  }
}
