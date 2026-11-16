// Maps wager transactions between the domain and their record; reads always go through WagerTransaction.rehydrate.
import {
  parseNullableTimestamp,
  parseTimestamp,
  type SelectedRow,
} from '../../../infrastructure/db/sql-columns';
import { Money } from '../../../shared/money/money';
import { FailureCode } from '../domain/failure-code';
import { WagerKind } from '../domain/wager-kind';
import { WagerStatus } from '../domain/wager-status';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionRecord } from './wager-transaction.record';

const KINDS = new Set<string>(Object.values(WagerKind));
const STATUSES = new Set<string>(Object.values(WagerStatus));
const FAILURE_CODES = new Set<string>(Object.values(FailureCode));

function toKind(value: string): WagerKind {
  if (!KINDS.has(value)) {
    throw new Error(`Unknown wager kind: ${value}`);
  }

  return value as WagerKind;
}

function toStatus(value: string): WagerStatus {
  if (!STATUSES.has(value)) {
    throw new Error(`Unknown wager status: ${value}`);
  }

  return value as WagerStatus;
}

function toFailureCode(value: string | null): FailureCode | null {
  if (value === null) {
    return null;
  }
  if (!FAILURE_CODES.has(value)) {
    throw new Error(`Unknown failure code: ${value}`);
  }

  return value as FailureCode;
}

function toObservedBalance(amount: string | null, currency: string | null): Money | null {
  if (amount === null || currency === null) {
    return null;
  }

  return Money.from({ amount, currency });
}

export const WagerTransactionMapper = {
  toDomain(row: SelectedRow<WagerTransactionRecord>): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: toKind(row.kind),
      money: Money.from({ amount: row.amount, currency: row.currency }),
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      correlationId: row.correlationId,
      createdAt: parseTimestamp(row.createdAt),
      status: toStatus(row.status),
      referenceTransactionId: row.referenceTransactionId,
      failureCode: toFailureCode(row.failureCode),
      processedAt: parseNullableTimestamp(row.processedAt),
      observedBalance: toObservedBalance(row.observedBalance, row.observedBalanceCurrency),
      attempts: row.attempts,
      nextAttemptAt: parseNullableTimestamp(row.nextAttemptAt),
      expiresAt: parseNullableTimestamp(row.expiresAt),
    });
  },

  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    const state = tx.toState();
    const observed = state.observedBalance?.toJSON() ?? null;

    return {
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      walletId: state.walletId,
      playerId: state.playerId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      amount: state.money.toJSON().amount,
      currency: state.money.currency,
      referenceExternalTransactionId: state.referenceExternalTransactionId,
      referenceTransactionId: state.referenceTransactionId,
      status: state.status,
      failureCode: state.failureCode,
      observedBalance: observed?.amount ?? null,
      observedBalanceCurrency: observed?.currency ?? null,
      correlationId: state.correlationId,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt,
      expiresAt: state.expiresAt,
      claimedUntil: null,
      claimedBy: null,
      createdAt: state.createdAt,
      processedAt: state.processedAt,
    };
  },
};
