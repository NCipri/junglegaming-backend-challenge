// Persistence record of the insert-only wallet_ledger_entries table; amounts are decimal strings.
import { EntitySchema } from '@mikro-orm/core';
import type { ColumnMap } from '../../../infrastructure/db/sql-columns';

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  currency: string;
  transactionId: string;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export const LEDGER_ENTRY_COLUMNS: ColumnMap<LedgerEntryRecord> = {
  id: 'id',
  walletId: 'wallet_id',
  currency: 'currency',
  transactionId: 'transaction_id',
  direction: 'direction',
  amount: 'amount',
  balanceBefore: 'balance_before',
  balanceAfter: 'balance_after',
  walletVersion: 'wallet_version',
  createdAt: 'created_at',
};

export const LedgerEntryRecordSchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: LEDGER_ENTRY_COLUMNS.walletId },
    currency: { type: 'string', columnType: 'char(3)' },
    transactionId: { type: 'uuid', fieldName: LEDGER_ENTRY_COLUMNS.transactionId },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    balanceBefore: {
      type: 'decimal',
      precision: 19,
      scale: 2,
      fieldName: LEDGER_ENTRY_COLUMNS.balanceBefore,
    },
    balanceAfter: {
      type: 'decimal',
      precision: 19,
      scale: 2,
      fieldName: LEDGER_ENTRY_COLUMNS.balanceAfter,
    },
    walletVersion: { type: 'integer', fieldName: LEDGER_ENTRY_COLUMNS.walletVersion },
    createdAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: LEDGER_ENTRY_COLUMNS.createdAt,
    },
  },
});
