// Outbox repository: inserts in the business transaction, leased claims in commit order (seq) with SKIP LOCKED and publish bookkeeping.
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxMessage } from '../domain/outbox-message';
import type { ClaimedOutboxMessage, ClaimOutboxParams } from './outbox.repository.types';
import {
  OutboxMessageRecordSchema,
  type OutboxMessageRecord,
} from './records/outbox-message.record';

const MAX_ERROR_LENGTH = 1000;

const CLAIM_SQL = `
  WITH claimed AS (
    UPDATE outbox_messages SET locked_until = ?, locked_by = ?
     WHERE id IN (
       SELECT o.id FROM outbox_messages o
        WHERE o.published_at IS NULL AND o.next_attempt_at <= ?
          AND (o.locked_until IS NULL OR o.locked_until < ?)
        ORDER BY o.seq
        LIMIT ?
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, partition_key, event_type, event_version, payload::text AS payload_text, attempts, seq
  )
  SELECT id, partition_key AS "partitionKey", event_type AS "eventType", event_version AS "eventVersion",
         payload_text AS "payloadText", attempts
    FROM claimed
   ORDER BY seq
`;

const OLDEST_PENDING_SQL = `
  SELECT COALESCE(EXTRACT(EPOCH FROM (?::timestamptz - MIN(occurred_at))), 0)::float8 AS age
    FROM outbox_messages
   WHERE published_at IS NULL
`;

function toRecord(msg: OutboxMessage): OutboxMessageRecord {
  const state = msg.toState();

  return {
    id: state.id,
    aggregateId: state.aggregateId,
    partitionKey: state.partitionKey,
    eventType: state.eventType,
    eventVersion: state.eventVersion,
    payload: state.payload,
    occurredAt: state.occurredAt,
    attempts: state.attempts,
    nextAttemptAt: state.nextAttemptAt,
    publishedAt: state.publishedAt,
  };
}

export class OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertMany(msgs: readonly OutboxMessage[]): Promise<void> {
    if (msgs.length === 0) {
      return;
    }
    await this.em.insertMany(OutboxMessageRecordSchema, msgs.map(toRecord));
  }

  claimDue(p: ClaimOutboxParams): Promise<ClaimedOutboxMessage[]> {
    const until = new Date(p.now.getTime() + p.leaseMs);

    return this.em.execute<ClaimedOutboxMessage[]>(CLAIM_SQL, [
      until,
      p.instanceId,
      p.now,
      p.now,
      p.limit,
    ]);
  }

  async markPublished(id: string, at: Date): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages SET published_at = ?, locked_until = NULL, locked_by = NULL
        WHERE id = ? AND published_at IS NULL`,
      [at, id],
      'run',
    );
  }

  async scheduleRetry(
    id: string,
    nextAttemptAt: Date,
    attempts: number,
    error: string,
  ): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, last_error = ?, locked_until = NULL, locked_by = NULL
        WHERE id = ? AND published_at IS NULL`,
      [attempts, nextAttemptAt, error.slice(0, MAX_ERROR_LENGTH), id],
      'run',
    );
  }

  async oldestPendingAgeSeconds(now: Date): Promise<number> {
    const rows = await this.em.execute<{ age: number }[]>(OLDEST_PENDING_SQL, [now]);

    return rows[0]?.age ?? 0;
  }
}
