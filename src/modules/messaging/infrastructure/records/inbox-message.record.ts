// Persistence record of the inbox_messages table, keyed by (consumer_name, message_id).
import { EntitySchema } from '@mikro-orm/core';

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageRecordSchema = new EntitySchema<InboxMessageRecord>({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true, fieldName: 'consumer_name' },
    messageId: { type: 'text', primary: true, fieldName: 'message_id' },
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'received_at' },
    processedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
  },
});
