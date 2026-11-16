// Persistence record of the wallets table; the balance stays a decimal string end to end.
import { EntitySchema } from '@mikro-orm/core';
import type { ColumnMap } from '../../../infrastructure/db/sql-columns';

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WALLET_COLUMNS: ColumnMap<WalletRecord> = {
  id: 'id',
  playerId: 'player_id',
  currency: 'currency',
  balance: 'balance',
  version: 'version',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

export const WalletRecordSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: WALLET_COLUMNS.playerId },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'decimal', precision: 19, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: WALLET_COLUMNS.createdAt },
    updatedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: WALLET_COLUMNS.updatedAt },
  },
});
