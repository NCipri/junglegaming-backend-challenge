import { describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  parseNullableTimestamp,
  parseTimestamp,
  selectList,
} from '../../../src/infrastructure/db/sql-columns';
import { WalletTransactionRunner } from '../../../src/infrastructure/db/wallet-transaction-runner';
import { OutboxRepository } from '../../../src/modules/messaging/infrastructure/outbox.repository';
import { NoopMetrics, type MetricsPort } from '../../../src/modules/observability/metrics.port';
import { WagerTransactionMapper } from '../../../src/modules/wagering/infrastructure/wager-transaction.mapper';
import type { WagerTransactionRecord } from '../../../src/modules/wagering/infrastructure/wager-transaction.record';
import { LedgerMapper } from '../../../src/modules/wallet/infrastructure/ledger.mapper';
import type { SelectedRow } from '../../../src/infrastructure/db/sql-columns';

const row: SelectedRow<WagerTransactionRecord> = {
  id: 'tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'key-1',
  payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  amount: '10.00',
  currency: 'BRL',
  referenceExternalTransactionId: null,
  referenceTransactionId: null,
  status: 'REJECTED',
  failureCode: 'INSUFFICIENT_BALANCE',
  observedBalance: null,
  observedBalanceCurrency: null,
  correlationId: 'corr-1',
  attempts: 0,
  nextAttemptAt: null,
  expiresAt: null,
  claimedUntil: null,
  claimedBy: null,
  createdAt: '2026-11-15 12:00:00+00',
  processedAt: '2026-11-15 12:00:01.5+00',
};

describe('timestamptz parsing', () => {
  test('parses the PostgreSQL text format, with and without fractions and minute offsets', () => {
    expect(parseTimestamp('2026-11-15 12:00:00+00').toISOString()).toBe('2026-11-15T12:00:00.000Z');
    expect(parseTimestamp('2026-11-15 12:00:00.123456+00').toISOString()).toBe(
      '2026-11-15T12:00:00.123Z',
    );
    expect(parseTimestamp('2026-11-15 09:30:00-03:30').toISOString()).toBe(
      '2026-11-15T13:00:00.000Z',
    );
  });

  test('copies Date inputs and keeps null', () => {
    const date = new Date('2026-11-15T12:00:00.000Z');
    const parsed = parseTimestamp(date);

    expect(parsed).toEqual(date);
    expect(parsed).not.toBe(date);
    expect(parseNullableTimestamp(null)).toBeNull();
  });

  test('rejects anything that is not a timestamptz', () => {
    expect(() => parseTimestamp('15/11/2026')).toThrow('Unexpected timestamptz value');
    expect(() => parseTimestamp('2026-13-45 99:99:99+00')).toThrow('Unexpected timestamptz value');
  });

  test('selectList aliases every column to its record property', () => {
    expect(selectList({ id: 'id', playerId: 'player_id' }, 'w')).toBe(
      'w.id AS "id", w.player_id AS "playerId"',
    );
  });
});

describe('mappers refuse values outside the domain enums', () => {
  test('a valid row maps to the domain', () => {
    const tx = WagerTransactionMapper.toDomain(row);

    expect(tx.processedAt?.toISOString()).toBe('2026-11-15T12:00:01.500Z');
    expect(tx.observedBalance).toBeNull();
  });

  test.each([
    [{ kind: 'JACKPOT' }, 'Unknown wager kind'],
    [{ status: 'PENDING_FOREVER' }, 'Unknown wager status'],
    [{ failureCode: 'OOPS' }, 'Unknown failure code'],
  ])('%p is rejected', (override, message) => {
    expect(() => WagerTransactionMapper.toDomain({ ...row, ...override })).toThrow(message);
  });

  test('an unknown ledger direction is rejected', () => {
    expect(() =>
      LedgerMapper.toDomain({
        id: 'e-1',
        walletId: 'wallet-1',
        currency: 'BRL',
        transactionId: 'tx-1',
        direction: 'SIDEWAYS',
        amount: '1.00',
        balanceBefore: '0.00',
        balanceAfter: '1.00',
        walletVersion: 1,
        createdAt: '2026-11-15 12:00:00+00',
      }),
    ).toThrow('Unknown ledger direction');
  });
});

describe('defensive guards', () => {
  const unusedEm = {
    insertMany: () => {
      throw new Error('must not be called');
    },
  } as unknown as EntityManager;

  test('the runner refuses a non-integer timeout', () => {
    expect(
      () =>
        new WalletTransactionRunner(unusedEm, new NoopMetrics(), {
          lockTimeoutMs: 1.5,
          statementTimeoutMs: 10,
          idleInTxTimeoutMs: 10,
        }),
    ).toThrow('Invalid timeout');
  });

  test('inserting an empty outbox batch issues no SQL', async () => {
    expect(await new OutboxRepository(unusedEm).insertMany([])).toBeUndefined();
  });

  test('NoopMetrics accepts every call', () => {
    const metrics: MetricsPort = new NoopMetrics();

    metrics.increment('lock_conflicts_total');
    metrics.observe('wallet_lock_wait_seconds', 1);
    metrics.set('dlq_depth', 0);

    expect(metrics).toBeInstanceOf(NoopMetrics);
  });
});
