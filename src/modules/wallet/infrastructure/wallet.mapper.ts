// Maps wallets between the domain aggregate and its record; reads always go through Wallet.rehydrate.
import { parseTimestamp, type SelectedRow } from '../../../infrastructure/db/sql-columns';
import { Money } from '../../../shared/money/money';
import { Wallet } from '../domain/wallet';
import type { WalletRecord } from './wallet.record';

export const WalletMapper = {
  toDomain(row: SelectedRow<WalletRecord>): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: Money.from({ amount: row.balance, currency: row.currency }),
      version: row.version,
      createdAt: parseTimestamp(row.createdAt),
      updatedAt: parseTimestamp(row.updatedAt),
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    const state = wallet.toState();

    return {
      id: state.id,
      playerId: state.playerId,
      currency: state.currency,
      balance: state.balance.toJSON().amount,
      version: state.version,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  },
};
