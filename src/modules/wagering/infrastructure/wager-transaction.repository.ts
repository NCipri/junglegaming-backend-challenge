// Wager transaction repository: explicit SQL for lookups, final-state inserts, guarded updates, reference facts and pending leases.
import type { QueryResult } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { VersionConflictError } from '../../../infrastructure/db/persistence.errors';
import { selectList, type SelectedRow } from '../../../infrastructure/db/sql-columns';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import {
  WAGER_TRANSACTION_COLUMNS,
  WagerTransactionRecordSchema,
  type WagerTransactionRecord,
} from './wager-transaction.record';
import type { ClaimPendingParams, ReferenceFacts } from './wager-transaction.repository.types';

const SELECT = `SELECT ${selectList(WAGER_TRANSACTION_COLUMNS)} FROM wager_transactions`;

const REFERENCE_FACTS_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM wager_transactions r
       WHERE r.reference_transaction_id = ? AND r.kind IN ('REFUND', 'ROLLBACK') AND r.status = 'PROCESSED'
    ) AS "hasAnyReversal",
    EXISTS (
      SELECT 1 FROM wager_transactions r
       WHERE r.reference_transaction_id = ? AND r.kind IN ('REFUND', 'ROLLBACK') AND r.status = 'PROCESSED'
         AND NOT EXISTS (
           SELECT 1 FROM wager_transactions undo
            WHERE undo.reference_transaction_id = r.id AND undo.kind = 'ROLLBACK' AND undo.status = 'PROCESSED'
         )
    ) AS "hasEffectiveReversal",
    EXISTS (
      SELECT 1 FROM wager_transactions win
       WHERE win.reference_transaction_id = ? AND win.kind = 'WIN' AND win.status = 'PROCESSED'
         AND NOT EXISTS (
           SELECT 1 FROM wager_transactions undo
            WHERE undo.reference_transaction_id = win.id AND undo.kind = 'ROLLBACK' AND undo.status = 'PROCESSED'
         )
    ) AS "hasActiveSettlingWin"
`;

const ACCELERATE_SQL = `
  UPDATE wager_transactions SET next_attempt_at = ?
   WHERE id IN (
     SELECT id FROM wager_transactions
      WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
        AND next_attempt_at > ?
      ORDER BY id
      FOR UPDATE SKIP LOCKED
   )
`;

const CLAIM_PENDING_SQL = `
  WITH claimed AS (
    UPDATE wager_transactions SET claimed_until = ?, claimed_by = ?
     WHERE id IN (
       SELECT id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
          AND (claimed_until IS NULL OR claimed_until < ?)
        ORDER BY id
        LIMIT ?
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id
  )
  SELECT id FROM claimed ORDER BY id
`;

export class WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<WagerTransaction | null> {
    return this.one(`${SELECT} WHERE id = ?`, [id]);
  }

  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | null> {
    return this.one(`${SELECT} WHERE provider_id = ? AND idempotency_key = ?`, [providerId, key]);
  }

  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null> {
    return this.one(`${SELECT} WHERE provider_id = ? AND external_transaction_id = ?`, [
      providerId,
      externalId,
    ]);
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecordSchema, WagerTransactionMapper.toRecord(tx));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const record = WagerTransactionMapper.toRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecordSchema,
      { id: record.id, status: 'PENDING_REFERENCE' },
      {
        status: record.status,
        failureCode: record.failureCode,
        referenceTransactionId: record.referenceTransactionId,
        observedBalance: record.observedBalance,
        observedBalanceCurrency: record.observedBalanceCurrency,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        processedAt: record.processedAt,
        claimedUntil: null,
        claimedBy: null,
      },
    );

    if (affected !== 1) {
      throw new VersionConflictError('wager_transactions', tx.id);
    }
  }

  async referenceFacts(ref: WagerTransaction): Promise<ReferenceFacts> {
    const rows = await this.em.execute<ReferenceFacts[]>(REFERENCE_FACTS_SQL, [
      ref.id,
      ref.id,
      ref.id,
    ]);
    const row = rows[0];

    return {
      hasAnyReversal: row?.hasAnyReversal === true,
      hasEffectiveReversal: row?.hasEffectiveReversal === true,
      hasActiveSettlingWin: row?.hasActiveSettlingWin === true,
    };
  }

  async accelerateDependents(providerId: string, externalId: string, now: Date): Promise<number> {
    const result = await this.em.execute<QueryResult>(
      ACCELERATE_SQL,
      [now, providerId, externalId, now],
      'run',
    );

    return result.affectedRows;
  }

  async claimDuePending(p: ClaimPendingParams): Promise<string[]> {
    const until = new Date(p.now.getTime() + p.leaseMs);
    const rows = await this.em.execute<{ id: string }[]>(CLAIM_PENDING_SQL, [
      until,
      p.instanceId,
      p.now,
      p.now,
      p.limit,
    ]);

    return rows.map((row) => row.id);
  }

  private async one(sql: string, params: unknown[]): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<SelectedRow<WagerTransactionRecord>[]>(sql, params);
    const row = rows[0];

    return row ? WagerTransactionMapper.toDomain(row) : null;
  }
}
