// Persistence record of the wager_transactions table; amount and observed balance are decimal strings (D-009).
import { EntitySchema } from '@mikro-orm/core';
import type { ColumnMap } from '../../../infrastructure/db/sql-columns';

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  observedBalance: string | null;
  observedBalanceCurrency: string | null;
  correlationId: string;
  attempts: number;
  nextAttemptAt: Date | null;
  expiresAt: Date | null;
  claimedUntil: Date | null;
  claimedBy: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WAGER_TRANSACTION_COLUMNS: ColumnMap<WagerTransactionRecord> = {
  id: 'id',
  providerId: 'provider_id',
  externalTransactionId: 'external_transaction_id',
  idempotencyKey: 'idempotency_key',
  payloadHash: 'payload_hash',
  walletId: 'wallet_id',
  playerId: 'player_id',
  roundId: 'round_id',
  gameId: 'game_id',
  kind: 'kind',
  amount: 'amount',
  currency: 'currency',
  referenceExternalTransactionId: 'reference_external_transaction_id',
  referenceTransactionId: 'reference_transaction_id',
  status: 'status',
  failureCode: 'failure_code',
  observedBalance: 'observed_balance',
  observedBalanceCurrency: 'observed_balance_currency',
  correlationId: 'correlation_id',
  attempts: 'attempts',
  nextAttemptAt: 'next_attempt_at',
  expiresAt: 'expires_at',
  claimedUntil: 'claimed_until',
  claimedBy: 'claimed_by',
  createdAt: 'created_at',
  processedAt: 'processed_at',
};

const text = (fieldName: string) => ({ type: 'text', fieldName }) as const;
const nullableText = (fieldName: string) => ({ type: 'text', fieldName, nullable: true }) as const;
const timestamp = (fieldName: string, nullable: boolean) =>
  ({ type: 'datetime', columnType: 'timestamptz', fieldName, nullable }) as const;
const C = WAGER_TRANSACTION_COLUMNS;

export const WagerTransactionRecordSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: text(C.providerId),
    externalTransactionId: text(C.externalTransactionId),
    idempotencyKey: text(C.idempotencyKey),
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: C.payloadHash },
    walletId: { type: 'uuid', fieldName: C.walletId },
    playerId: { type: 'uuid', fieldName: C.playerId },
    roundId: nullableText(C.roundId),
    gameId: nullableText(C.gameId),
    kind: text(C.kind),
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: nullableText(C.referenceExternalTransactionId),
    referenceTransactionId: { type: 'uuid', fieldName: C.referenceTransactionId, nullable: true },
    status: text(C.status),
    failureCode: nullableText(C.failureCode),
    observedBalance: {
      type: 'decimal',
      precision: 19,
      scale: 2,
      fieldName: C.observedBalance,
      nullable: true,
    },
    observedBalanceCurrency: {
      type: 'string',
      columnType: 'char(3)',
      fieldName: C.observedBalanceCurrency,
      nullable: true,
    },
    correlationId: text(C.correlationId),
    attempts: { type: 'integer' },
    nextAttemptAt: timestamp(C.nextAttemptAt, true),
    expiresAt: timestamp(C.expiresAt, true),
    claimedUntil: timestamp(C.claimedUntil, true),
    claimedBy: nullableText(C.claimedBy),
    createdAt: timestamp(C.createdAt, false),
    processedAt: timestamp(C.processedAt, true),
  },
});
