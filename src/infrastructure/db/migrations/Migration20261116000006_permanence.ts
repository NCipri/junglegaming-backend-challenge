// Permanence: wager transactions and wallets are never deleted, and a wallet's identity columns never change.
import { Migration } from '@mikro-orm/migrations';

export class Migration20261116000006_permanence extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% rows cannot be deleted (row %)', TG_TABLE_NAME, OLD.id USING ERRCODE = 'P0001';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_delete();
    `);
    this.addSql(`
      CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION forbid_delete();
    `);
    this.addSql(`
      CREATE FUNCTION wallets_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet % has immutable columns that cannot change', OLD.id USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallets_identity_guard BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_identity_guard();
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER wallets_identity_guard ON wallets;');
    this.addSql('DROP FUNCTION wallets_identity_guard();');
    this.addSql('DROP TRIGGER wallets_no_delete ON wallets;');
    this.addSql('DROP TRIGGER wager_transactions_no_delete ON wager_transactions;');
    this.addSql('DROP FUNCTION forbid_delete();');
  }
}
