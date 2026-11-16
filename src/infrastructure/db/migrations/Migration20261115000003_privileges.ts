// Least-privilege grants for the runtime role app (D-012): the ledger is insert-only, providers read-only.
import { Migration } from '@mikro-orm/migrations';

export class Migration20261115000003_privileges extends Migration {
  override up(): void {
    this.addSql('GRANT SELECT ON providers TO app;');
    this.addSql(
      'GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages, outbox_messages TO app;',
    );
    this.addSql('GRANT SELECT, INSERT ON wallet_ledger_entries TO app;');
    this.addSql(
      'ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO app;',
    );
  }

  override down(): void {
    this.addSql(
      'ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public REVOKE SELECT, INSERT, UPDATE ON TABLES FROM app;',
    );
    this.addSql('REVOKE ALL ON wallet_ledger_entries FROM app;');
    this.addSql(
      'REVOKE ALL ON wallets, wager_transactions, inbox_messages, outbox_messages FROM app;',
    );
    this.addSql('REVOKE ALL ON providers FROM app;');
  }
}
