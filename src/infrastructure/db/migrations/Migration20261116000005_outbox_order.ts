// Outbox commit order: a sequence assigned at insert (under the wallet lock) and an index over pending rows by that order.
import { Migration } from '@mikro-orm/migrations';

export class Migration20261116000005_outbox_order extends Migration {
  override up(): void {
    this.addSql('ALTER TABLE outbox_messages ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;');
    this.addSql(
      'CREATE INDEX outbox_messages_pending_seq_idx ON outbox_messages (seq) WHERE published_at IS NULL;',
    );
  }

  override down(): void {
    this.addSql('DROP INDEX outbox_messages_pending_seq_idx;');
    this.addSql('ALTER TABLE outbox_messages DROP COLUMN seq;');
  }
}
