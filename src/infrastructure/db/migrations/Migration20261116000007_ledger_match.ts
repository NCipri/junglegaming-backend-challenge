// At commit, a wallet's balance and version must equal its last ledger entry (or 0.00 at version 1 with no entries).
import { Migration } from '@mikro-orm/migrations';

export class Migration20261116000007_ledger_match extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        target UUID;
        stored_balance NUMERIC(19, 2);
        stored_version INTEGER;
        last_after NUMERIC(19, 2);
        last_version INTEGER;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target := NEW.id;
        ELSE
          target := NEW.wallet_id;
        END IF;
        SELECT balance, version INTO stored_balance, stored_version FROM wallets WHERE id = target;
        IF NOT FOUND THEN
          RETURN NULL;
        END IF;
        SELECT balance_after, wallet_version INTO last_after, last_version
          FROM wallet_ledger_entries
         WHERE wallet_id = target
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF NOT FOUND THEN
          last_after := 0;
          last_version := 1;
        END IF;
        IF stored_balance <> last_after OR stored_version <> last_version THEN
          RAISE EXCEPTION 'wallet % does not match its ledger (balance %, version %; last entry %, version %)',
            target, stored_balance, stored_version, last_after, last_version
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_match_ledger AFTER INSERT OR UPDATE OF balance, version ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_entries_match_wallet AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger();
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER ledger_entries_match_wallet ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER wallets_match_ledger ON wallets;');
    this.addSql('DROP FUNCTION wallet_matches_ledger();');
  }
}
