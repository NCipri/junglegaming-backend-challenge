// Triggers: immutable ledger, terminal/immutable wager transactions and the BET-already-settled guard (D-050).
import { Migration } from '@mikro-orm/migrations';

export class Migration20261115000002_triggers extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries are immutable (% on entry %)', TG_OP, OLD.id
          USING ERRCODE = 'P0001';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();
    `);
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'P0001';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.correlation_id, NEW.expires_at, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.correlation_id, OLD.expires_at, OLD.created_at) THEN
          RAISE EXCEPTION 'wager transaction % has immutable columns that cannot change', OLD.id
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();
    `);
    this.addSql(`
      CREATE FUNCTION wager_reversal_settled_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM wager_transactions bet
            JOIN wager_transactions win
              ON win.reference_transaction_id = bet.id AND win.kind = 'WIN' AND win.status = 'PROCESSED'
           WHERE bet.id = NEW.reference_transaction_id
             AND bet.kind = 'BET'
             AND NOT EXISTS (
               SELECT 1 FROM wager_transactions undo
                WHERE undo.reference_transaction_id = win.id
                  AND undo.kind = 'ROLLBACK' AND undo.status = 'PROCESSED'
             )
        ) THEN
          RAISE EXCEPTION 'BET % is already settled by a WIN; roll back the WIN first',
            NEW.reference_transaction_id USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_reversal_settled_guard BEFORE INSERT OR UPDATE OF status ON wager_transactions
        FOR EACH ROW WHEN (NEW.status = 'PROCESSED' AND NEW.kind IN ('REFUND', 'ROLLBACK'))
        EXECUTE FUNCTION wager_reversal_settled_guard();
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER wager_reversal_settled_guard ON wager_transactions;');
    this.addSql('DROP FUNCTION wager_reversal_settled_guard();');
    this.addSql('DROP TRIGGER wager_transactions_guard ON wager_transactions;');
    this.addSql('DROP FUNCTION wager_transactions_guard();');
    this.addSql('DROP TRIGGER ledger_entries_immutable ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION ledger_entries_immutable();');
  }
}
