// Persistence record of the outbox_messages table; the payload is the serialized event envelope.
import { EntitySchema } from '@mikro-orm/core';

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

export const OutboxMessageRecordSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'text', fieldName: 'aggregate_id' },
    partitionKey: { type: 'text', fieldName: 'partition_key' },
    eventType: { type: 'text', fieldName: 'event_type' },
    eventVersion: { type: 'integer', fieldName: 'event_version' },
    payload: { type: 'json', columnType: 'json' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'next_attempt_at' },
    publishedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'published_at',
      nullable: true,
    },
  },
});
