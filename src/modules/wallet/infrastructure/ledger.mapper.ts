// Maps ledger entries between the domain and their record; reads always go through WalletLedgerEntry.rehydrate.
import { parseTimestamp, type SelectedRow } from '../../../infrastructure/db/sql-columns';
import { Money } from '../../../shared/money/money';
import { LedgerDirection } from '../domain/ledger-direction';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { LedgerEntryRecord } from './ledger-entry.record';

function toDirection(value: string): LedgerDirection {
  if (value === 'DEBIT') {
    return LedgerDirection.Debit;
  }
  if (value === 'CREDIT') {
    return LedgerDirection.Credit;
  }
  throw new Error(`Unknown ledger direction: ${value}`);
}

export const LedgerMapper = {
  toDomain(row: SelectedRow<LedgerEntryRecord>): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: row.currency });

    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: toDirection(row.direction),
      money: money(row.amount),
      balanceBefore: money(row.balanceBefore),
      balanceAfter: money(row.balanceAfter),
      walletVersion: row.walletVersion,
      createdAt: parseTimestamp(row.createdAt),
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      currency: entry.money.currency,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },
};
