// Initial schema: providers, wallets, wager transactions, ledger, inbox and outbox with named constraints.
import { Migration } from '@mikro-orm/migrations';

export class Migration20261115000001_initial_schema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT providers_status_valid CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT providers_id_format CHECK (id ~ '^[!-~]{1,120}$'),
        CONSTRAINT providers_id_not_internal CHECK (id <> 'internal')
      );
    `);
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance NUMERIC(19, 2) NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_key UNIQUE (id, currency),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1)
      );
    `);
    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL,
        player_id UUID NOT NULL,
        round_id TEXT NULL,
        game_id TEXT NULL,
        kind TEXT NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_external_transaction_id TEXT NULL,
        reference_transaction_id UUID NULL
          CONSTRAINT wager_transactions_reference_fkey REFERENCES wager_transactions (id),
        status TEXT NOT NULL,
        failure_code TEXT NULL,
        observed_balance NUMERIC(19, 2) NULL,
        observed_balance_currency CHAR(3) NULL,
        correlation_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        expires_at TIMESTAMPTZ NULL,
        claimed_until TIMESTAMPTZ NULL,
        claimed_by TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT wager_transactions_provider_idempotency_key UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_transactions_provider_external_id_key UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_kind_valid
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid
          CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_transactions_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT wager_transactions_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_transactions_zero_amount_kind
          CHECK (amount > 0 OR kind IN ('WIN', 'LOSS', 'ROLLBACK')),
        CONSTRAINT wager_transactions_round_game_required
          CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT wager_transactions_failure_code_matches_status
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_failure_code_valid CHECK (failure_code IS NULL OR failure_code IN (
          'INSUFFICIENT_BALANCE', 'REVERSAL_WOULD_OVERDRAW', 'CURRENCY_MISMATCH', 'WALLET_NOT_FOUND',
          'PLAYER_WALLET_MISMATCH', 'UNKNOWN_PROVIDER', 'REFERENCE_REQUIRED', 'REFERENCE_NOT_FOUND',
          'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND', 'REFERENCE_AMOUNT_MISMATCH',
          'REFERENCE_NOT_PROCESSED', 'ALREADY_REVERSED', 'BET_ALREADY_SETTLED', 'OPENING_NOT_ALLOWED',
          'UNEXPECTED_PROCESSING_ERROR')),
        CONSTRAINT wager_transactions_terminal_has_processed_at
          CHECK (status = 'PENDING_REFERENCE' OR processed_at IS NOT NULL),
        CONSTRAINT wager_transactions_reversal_has_reference CHECK (
          NOT (status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NULL)
        ),
        CONSTRAINT wager_transactions_pending_has_schedule CHECK (
          status <> 'PENDING_REFERENCE' OR (next_attempt_at IS NOT NULL AND expires_at IS NOT NULL)
        ),
        CONSTRAINT wager_transactions_observed_balance_pair
          CHECK ((observed_balance IS NULL) = (observed_balance_currency IS NULL)),
        CONSTRAINT wager_transactions_attempts_non_negative CHECK (attempts >= 0)
      );
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
    this.addSql(
      `CREATE INDEX wager_transactions_reference_idx ON wager_transactions (reference_transaction_id);`,
    );
    this.addSql(`
      CREATE INDEX wager_transactions_pending_due_idx ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        transaction_id UUID NOT NULL
          CONSTRAINT wallet_ledger_entries_transaction_fkey REFERENCES wager_transactions (id),
        direction TEXT NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        balance_before NUMERIC(19, 2) NOT NULL,
        balance_after NUMERIC(19, 2) NOT NULL,
        wallet_version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallet_ledger_entries_wallet_currency_fkey
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wallet_ledger_entries_transaction_wallet_key UNIQUE (transaction_id, wallet_id),
        CONSTRAINT wallet_ledger_entries_wallet_version_key UNIQUE (wallet_id, wallet_version),
        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balances_non_negative
          CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
      );
    `);
    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        partition_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL,
        payload JSON NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_until TIMESTAMPTZ NULL,
        locked_by TEXT NULL,
        published_at TIMESTAMPTZ NULL,
        last_error TEXT NULL,
        CONSTRAINT outbox_messages_event_version_positive CHECK (event_version >= 1),
        CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0)
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_pending_idx ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages;');
    this.addSql('DROP TABLE inbox_messages;');
    this.addSql('DROP TABLE wallet_ledger_entries;');
    this.addSql('DROP TABLE wager_transactions;');
    this.addSql('DROP TABLE wallets;');
    this.addSql('DROP TABLE providers;');
  }
}
