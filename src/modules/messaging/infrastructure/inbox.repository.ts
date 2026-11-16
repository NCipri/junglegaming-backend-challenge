// Inbox repository: atomic dedupe insert that tells a duplicate apart from a payload conflict (D-022, D-058).
import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../domain/inbox-message';
import type { InboxInsertOutcome } from './inbox.repository.types';
import { InboxMessageRecordSchema } from './records/inbox-message.record';

const INSERT_SQL = `
  INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (consumer_name, message_id) DO NOTHING
  RETURNING message_id
`;

export class InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(msg: InboxMessage): Promise<InboxInsertOutcome> {
    const inserted = await this.em.execute<{ message_id: string }[]>(INSERT_SQL, [
      msg.consumerName,
      msg.messageId,
      msg.payloadHash,
      msg.receivedAt,
      msg.processedAt ?? null,
    ]);

    if (inserted.length === 1) {
      return 'INSERTED';
    }
    const existing = await this.em.execute<{ payload_hash: string }[]>(
      'SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      [msg.consumerName, msg.messageId],
    );

    return existing[0]?.payload_hash === msg.payloadHash ? 'DUPLICATE' : 'PAYLOAD_CONFLICT';
  }

  async markProcessed(msg: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecordSchema,
      { consumerName: msg.consumerName, messageId: msg.messageId },
      { processedAt: msg.processedAt ?? null },
    );
  }
}
