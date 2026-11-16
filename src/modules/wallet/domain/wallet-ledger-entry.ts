// Immutable wallet ledger entry whose factory enforces before ± money = after.
import { Money } from '../../../shared/money/money';
import { LedgerDirection } from './ledger-direction';
import { UnbalancedLedgerEntryError } from './wallet.errors';
import type { LedgerEntryState } from './wallet-ledger-entry.types';

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAt = new Date(state.createdAt);
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(state);

    if (!entry.money.isPositive()) {
      throw new UnbalancedLedgerEntryError('amount must be positive');
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError('balances must not be negative');
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new UnbalancedLedgerEntryError('wallet version must be a positive integer');
    }
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError('before ± amount must equal after');
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expected.equals(this.balanceAfter);
  }
}
