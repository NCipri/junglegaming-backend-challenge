import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Client, DatabaseError } from 'pg';
import { Client as PgClient } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';

let pg: TestPostgres;
let db: Client;
let seq = 0;

const LEDGER_MATCH_TRIGGERS = [
  'ALTER TABLE wallets {0} TRIGGER wallets_match_ledger',
  'ALTER TABLE wallet_ledger_entries {0} TRIGGER ledger_entries_match_wallet',
];

async function ledgerMatch(action: 'ENABLE' | 'DISABLE'): Promise<void> {
  for (const statement of LEDGER_MATCH_TRIGGERS) {
    await db.query(statement.replace('{0}', action));
  }
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateUp(pg.migratorUrl);
  db = new PgClient({ connectionString: pg.migratorUrl });
  await db.connect();
  await ledgerMatch('DISABLE');
}, 120_000);

afterAll(async () => {
  await db.end();
  await pg.stop();
});

beforeEach(async () => {
  await resetDatabase(pg.migratorUrl);
});

const uuid = () => Bun.randomUUIDv7();
const NOW = '2026-11-15T12:00:00Z';
const HASH = 'a'.repeat(64);

async function failure(sql: string, params: unknown[] = []): Promise<DatabaseError> {
  try {
    await db.query(sql, params);
  } catch (error) {
    return error as DatabaseError;
  }
  throw new Error(`expected the statement to fail: ${sql}`);
}

async function errorOf(work: Promise<unknown>): Promise<DatabaseError> {
  try {
    await work;
  } catch (error) {
    return error as DatabaseError;
  }
  throw new Error('expected the operation to fail');
}

async function wallet(
  overrides: { id?: string; playerId?: string; currency?: string; balance?: string } = {},
) {
  const id = overrides.id ?? uuid();

  await db.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5)`,
    [
      id,
      overrides.playerId ?? uuid(),
      overrides.currency ?? 'BRL',
      overrides.balance ?? '100.00',
      NOW,
    ],
  );

  return id;
}

interface TxRow {
  id?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  walletId: string;
  kind?: string;
  amount?: string;
  status?: string;
  failureCode?: string | null;
  referenceTransactionId?: string | null;
  referenceExternalId?: string | null;
  roundId?: string | null;
  nextAttemptAt?: string | null;
  expiresAt?: string | null;
  processedAt?: string | null;
}

const TX_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
  player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, observed_balance, observed_balance_currency,
  correlation_id, attempts, next_attempt_at, expires_at, created_at, processed_at`;

function txValues(row: TxRow): unknown[] {
  seq += 1;
  const status = row.status ?? 'PROCESSED';
  const terminal = status !== 'PENDING_REFERENCE';

  return [
    row.id ?? uuid(),
    row.providerId ?? 'provider-a',
    row.externalId ?? `ext-${seq}`,
    row.idempotencyKey ?? `key-${seq}`,
    HASH,
    row.walletId,
    uuid(),
    row.roundId === undefined ? 'round-1' : row.roundId,
    row.roundId === null ? null : 'game-1',
    row.kind ?? 'BET',
    row.amount ?? '10.00',
    'BRL',
    row.referenceExternalId ?? null,
    row.referenceTransactionId ?? null,
    status,
    row.failureCode === undefined
      ? status === 'REJECTED'
        ? 'INSUFFICIENT_BALANCE'
        : null
      : row.failureCode,
    '90.00',
    'BRL',
    'corr-1',
    0,
    row.nextAttemptAt === undefined ? (terminal ? null : NOW) : row.nextAttemptAt,
    row.expiresAt === undefined ? (terminal ? null : NOW) : row.expiresAt,
    NOW,
    row.processedAt === undefined ? (terminal ? NOW : null) : row.processedAt,
  ];
}

const TX_INSERT = `INSERT INTO wager_transactions (${TX_COLUMNS}) VALUES (${Array.from({ length: 24 }, (_, i) => `$${i + 1}`).join(', ')})`;

async function tx(row: TxRow): Promise<string> {
  const values = txValues(row);

  await db.query(TX_INSERT, values);

  return values[0] as string;
}

const txFailure = (row: TxRow) => failure(TX_INSERT, txValues(row));

async function ledger(row: {
  walletId: string;
  transactionId: string;
  direction?: string;
  amount?: string;
  before?: string;
  after?: string;
  version?: number;
  currency?: string;
}) {
  await db.query(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, currency, transaction_id, direction, amount,
       balance_before, balance_after, wallet_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      uuid(),
      row.walletId,
      row.currency ?? 'BRL',
      row.transactionId,
      row.direction ?? 'DEBIT',
      row.amount ?? '10.00',
      row.before ?? '100.00',
      row.after ?? '90.00',
      row.version ?? 2,
      NOW,
    ],
  );
}

describe('wallets', () => {
  test('balance can never be negative', async () => {
    const error = await failure(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', '-0.01', 1, $3, $3)`,
      [uuid(), uuid(), NOW],
    );

    expect(error.constraint).toBe('wallets_balance_non_negative');
  });

  test('one wallet per player and currency', async () => {
    const playerId = uuid();

    await wallet({ playerId });
    expect(
      (
        await failure(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', '0.00', 1, $3, $3)`,
          [uuid(), playerId, NOW],
        )
      ).constraint,
    ).toBe('wallets_player_currency_key');
    await wallet({ playerId, currency: 'USD' });
  });

  test('currency must be an ISO-4217 code', async () => {
    const error = await failure(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'brl', '0.00', 1, $3, $3)`,
      [uuid(), uuid(), NOW],
    );

    expect(error.constraint).toBe('wallets_currency_format');
  });

  test('version starts at 1 or above', async () => {
    const error = await failure(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', '0.00', 0, $3, $3)`,
      [uuid(), uuid(), NOW],
    );

    expect(error.constraint).toBe('wallets_version_positive');
  });
});

describe('wager_transactions', () => {
  test('a BET of zero is refused; a LOSS of zero is accepted', async () => {
    const walletId = await wallet();

    expect((await txFailure({ walletId, kind: 'BET', amount: '0.00' })).constraint).toBe(
      'wager_transactions_zero_amount_kind',
    );
    await tx({ walletId, kind: 'LOSS', amount: '0.00' });
  });

  test('REJECTED requires a failure code, and only REJECTED/FAILED may have one', async () => {
    const walletId = await wallet();

    expect((await txFailure({ walletId, status: 'REJECTED', failureCode: null })).constraint).toBe(
      'wager_transactions_failure_code_matches_status',
    );
    expect(
      (await txFailure({ walletId, status: 'PROCESSED', failureCode: 'INSUFFICIENT_BALANCE' }))
        .constraint,
    ).toBe('wager_transactions_failure_code_matches_status');
  });

  test('failure codes come from the documented taxonomy', async () => {
    const walletId = await wallet();

    expect(
      (await txFailure({ walletId, status: 'REJECTED', failureCode: 'OOPS' })).constraint,
    ).toBe('wager_transactions_failure_code_valid');
  });

  test('a PROCESSED reversal must point at its reference', async () => {
    const walletId = await wallet();

    expect(
      (
        await txFailure({
          walletId,
          kind: 'REFUND',
          referenceExternalId: 'x',
          referenceTransactionId: null,
        })
      ).constraint,
    ).toBe('wager_transactions_reversal_has_reference');
  });

  test('PENDING is never persisted', async () => {
    const walletId = await wallet();

    expect((await txFailure({ walletId, status: 'PENDING', processedAt: null })).constraint).toBe(
      'wager_transactions_status_valid',
    );
  });

  test('a terminal transaction has processed_at; a pending one has its schedule', async () => {
    const walletId = await wallet();

    expect((await txFailure({ walletId, status: 'PROCESSED', processedAt: null })).constraint).toBe(
      'wager_transactions_terminal_has_processed_at',
    );
    expect(
      (await txFailure({ walletId, kind: 'REFUND', status: 'PENDING_REFERENCE', expiresAt: null }))
        .constraint,
    ).toBe('wager_transactions_pending_has_schedule');
  });

  test('round and game are required except for OPENING', async () => {
    const walletId = await wallet();

    expect((await txFailure({ walletId, kind: 'BET', roundId: null })).constraint).toBe(
      'wager_transactions_round_game_required',
    );
    await tx({
      walletId,
      kind: 'OPENING',
      amount: '100.00',
      providerId: 'internal',
      roundId: null,
    });
  });

  test('the idempotency key is unique per provider, not globally', async () => {
    const walletId = await wallet();

    await tx({ walletId, idempotencyKey: 'shared-key' });
    expect((await txFailure({ walletId, idempotencyKey: 'shared-key' })).constraint).toBe(
      'wager_transactions_provider_idempotency_key',
    );
    await tx({ walletId, idempotencyKey: 'shared-key', providerId: 'provider-b' });
  });

  test('the external transaction id is unique per provider', async () => {
    const walletId = await wallet();

    await tx({ walletId, externalId: 'ext-dup' });
    expect((await txFailure({ walletId, externalId: 'ext-dup' })).constraint).toBe(
      'wager_transactions_provider_external_id_key',
    );
  });

  test('a reference can be reversed by at most one PROCESSED reversal', async () => {
    const walletId = await wallet();
    const betId = await tx({ walletId, kind: 'BET' });

    await tx({ walletId, kind: 'REFUND', referenceExternalId: 'b', referenceTransactionId: betId });
    expect(
      (
        await txFailure({
          walletId,
          kind: 'ROLLBACK',
          referenceExternalId: 'b',
          referenceTransactionId: betId,
        })
      ).constraint,
    ).toBe('wager_transactions_single_reversal');
  });

  test('a terminal transaction cannot change status', async () => {
    const walletId = await wallet();
    const id = await tx({ walletId });
    const error = await failure(
      `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_BALANCE' WHERE id = $1`,
      [id],
    );

    expect(error.code).toBe('P0001');
    expect(error.message).toContain('terminal');
  });

  test('immutable columns cannot change, even while pending', async () => {
    const walletId = await wallet();
    const id = await tx({
      walletId,
      kind: 'REFUND',
      status: 'PENDING_REFERENCE',
      referenceExternalId: 'b',
    });
    const error = await failure(`UPDATE wager_transactions SET amount = '99.00' WHERE id = $1`, [
      id,
    ]);

    expect(error.code).toBe('P0001');
    expect(error.message).toContain('immutable');
  });

  test('a pending transaction may be rescheduled and resolved', async () => {
    const walletId = await wallet();
    const id = await tx({
      walletId,
      kind: 'LOSS',
      status: 'PENDING_REFERENCE',
      referenceExternalId: 'b',
    });

    await db.query(
      `UPDATE wager_transactions SET attempts = 1, next_attempt_at = $2 WHERE id = $1`,
      [id, NOW],
    );
    await db.query(
      `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = $2, next_attempt_at = NULL WHERE id = $1`,
      [id, NOW],
    );
  });
});

describe('BET already settled', () => {
  async function settledBet() {
    const walletId = await wallet();
    const betId = await tx({ walletId, kind: 'BET' });
    const winId = await tx({
      walletId,
      kind: 'WIN',
      amount: '50.00',
      referenceExternalId: 'b',
      referenceTransactionId: betId,
    });

    return { walletId, betId, winId };
  }

  test('a PROCESSED REFUND of a BET with an active WIN is refused on INSERT', async () => {
    const { walletId, betId } = await settledBet();
    const error = await txFailure({
      walletId,
      kind: 'REFUND',
      referenceExternalId: 'b',
      referenceTransactionId: betId,
    });

    expect(error.code).toBe('P0001');
    expect(error.message).toContain('settled');
  });

  test('a pending REFUND cannot be resolved to PROCESSED while the WIN stands (UPDATE)', async () => {
    const { walletId, betId } = await settledBet();
    const refundId = await tx({
      walletId,
      kind: 'REFUND',
      status: 'PENDING_REFERENCE',
      referenceExternalId: 'b',
    });
    const error = await failure(
      `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = $2, reference_transaction_id = $3,
         next_attempt_at = NULL WHERE id = $1`,
      [refundId, NOW, betId],
    );

    expect(error.code).toBe('P0001');
    expect(error.message).toContain('settled');
  });

  test('the REFUND is accepted once the WIN has been rolled back', async () => {
    const { walletId, betId, winId } = await settledBet();

    await tx({
      walletId,
      kind: 'ROLLBACK',
      amount: '50.00',
      referenceExternalId: 'w',
      referenceTransactionId: winId,
    });
    await tx({ walletId, kind: 'REFUND', referenceExternalId: 'b', referenceTransactionId: betId });
  });
});

describe('wallet_ledger_entries', () => {
  test('arithmetic must balance', async () => {
    const walletId = await wallet();
    const txId = await tx({ walletId });

    expect(await errorOf(ledger({ walletId, transactionId: txId, after: '80.00' }))).toMatchObject({
      constraint: 'wallet_ledger_entries_arithmetic',
    });
  });

  test('one entry per wallet version', async () => {
    const walletId = await wallet();

    await ledger({ walletId, transactionId: await tx({ walletId }), version: 2 });
    expect(
      await errorOf(
        ledger({
          walletId,
          transactionId: await tx({ walletId }),
          version: 2,
          before: '90.00',
          after: '80.00',
        }),
      ),
    ).toMatchObject({ constraint: 'wallet_ledger_entries_wallet_version_key' });
  });

  test('one entry per transaction per wallet', async () => {
    const walletId = await wallet();
    const txId = await tx({ walletId });

    await ledger({ walletId, transactionId: txId, version: 2 });
    expect(
      await errorOf(
        ledger({ walletId, transactionId: txId, version: 3, before: '90.00', after: '80.00' }),
      ),
    ).toMatchObject({ constraint: 'wallet_ledger_entries_transaction_wallet_key' });
  });

  test('the entry currency must be the wallet currency', async () => {
    const walletId = await wallet({ currency: 'BRL' });

    expect(
      await errorOf(ledger({ walletId, transactionId: await tx({ walletId }), currency: 'USD' })),
    ).toMatchObject({ constraint: 'wallet_ledger_entries_wallet_currency_fkey' });
  });

  test('entries are immutable, even for the schema owner', async () => {
    const walletId = await wallet();

    await ledger({ walletId, transactionId: await tx({ walletId }) });
    for (const sql of [
      `UPDATE wallet_ledger_entries SET amount = '1.00'`,
      `DELETE FROM wallet_ledger_entries`,
    ]) {
      const error = await failure(sql);

      expect(error.code).toBe('P0001');
      expect(error.message).toContain('immutable');
    }
  });
});

describe('permanence of wallets and transactions', () => {
  test('a wager transaction can never be deleted, even by the schema owner', async () => {
    const walletId = await wallet();
    const id = await tx({ walletId });
    const error = await failure('DELETE FROM wager_transactions WHERE id = $1', [id]);

    expect(error.code).toBe('P0001');
    expect(error.message).toContain('cannot be deleted');
  });

  test('a wallet can never be deleted', async () => {
    const walletId = await wallet();
    const error = await failure('DELETE FROM wallets WHERE id = $1', [walletId]);

    expect(error.code).toBe('P0001');
  });

  test.each([
    ['player_id', `'${'00000000-0000-7000-8000-000000000001'}'`],
    ['currency', "'USD'"],
    ['created_at', 'now()'],
  ])('the wallet %s is immutable', async (column, value) => {
    const walletId = await wallet();
    const error = await failure(`UPDATE wallets SET ${column} = ${value} WHERE id = $1`, [
      walletId,
    ]);

    expect(error.code).toBe('P0001');
    expect(error.message).toContain('immutable');
  });

  test('balance, version and updated_at of a wallet can still change', async () => {
    const walletId = await wallet();

    await db.query(
      'UPDATE wallets SET balance = 90.00, version = 2, updated_at = now() WHERE id = $1',
      [walletId],
    );
  });
});

describe('wallet balance and version always match the ledger (checked at commit)', () => {
  beforeAll(async () => {
    await ledgerMatch('ENABLE');
  });

  afterAll(async () => {
    await ledgerMatch('DISABLE');
  });

  async function inTransaction(work: () => Promise<void>): Promise<DatabaseError | null> {
    await db.query('BEGIN');
    try {
      await work();
      await db.query('COMMIT');

      return null;
    } catch (error) {
      await db.query('ROLLBACK');

      return error as DatabaseError;
    }
  }

  test('a wallet opened at 0.00 with no entries is valid', async () => {
    const walletId = await wallet({ balance: '0.00' });
    const { rows } = await db.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM wallets WHERE id = $1',
      [walletId],
    );

    expect(rows[0]?.n).toBe(1);
  });

  test('a wallet with a balance but no ledger entry is refused at commit', async () => {
    const error = await failure(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', '100.00', 1, $3, $3)`,
      [uuid(), uuid(), NOW],
    );

    expect(error.code).toBe('P0001');
    expect(error.message).toContain('does not match its ledger');
  });

  test('opening with a balance, its OPENING transaction and the CREDIT entry in one transaction is valid', async () => {
    const walletId = uuid();
    const error = await inTransaction(async () => {
      await wallet({ id: walletId, balance: '100.00' });
      const txId = await tx({ walletId, kind: 'WIN', amount: '100.00' });

      await ledger({
        walletId,
        transactionId: txId,
        direction: 'CREDIT',
        amount: '100.00',
        before: '0.00',
        after: '100.00',
        version: 1,
      });
    });

    expect(error).toBeNull();
  });

  test('changing the balance without a ledger entry is refused at commit', async () => {
    const walletId = await wallet({ balance: '0.00' });
    const error = await failure("UPDATE wallets SET balance = '5.00' WHERE id = $1", [walletId]);

    expect(error.code).toBe('P0001');
    expect(error.message).toContain('does not match its ledger');
  });

  test('a ledger entry without the matching wallet update is refused at commit', async () => {
    const walletId = await wallet({ balance: '0.00' });
    const error = await inTransaction(async () => {
      const txId = await tx({ walletId, kind: 'WIN', amount: '5.00' });

      await ledger({
        walletId,
        transactionId: txId,
        direction: 'CREDIT',
        amount: '5.00',
        before: '0.00',
        after: '5.00',
        version: 2,
      });
    });

    expect(error?.code).toBe('P0001');
  });

  test('a debit that updates the wallet and adds the entry in one transaction is valid', async () => {
    const walletId = await wallet({ balance: '0.00' });
    const error = await inTransaction(async () => {
      const txId = await tx({ walletId, kind: 'WIN', amount: '5.00' });

      await db.query("UPDATE wallets SET balance = '5.00', version = 2 WHERE id = $1", [walletId]);
      await ledger({
        walletId,
        transactionId: txId,
        direction: 'CREDIT',
        amount: '5.00',
        before: '0.00',
        after: '5.00',
        version: 2,
      });
    });

    expect(error).toBeNull();
  });
});

describe('outbox_messages and providers', () => {
  test('an outbox row without next_attempt_at is due immediately', async () => {
    const { rows } = await db.query<{ due: boolean }>(
      `INSERT INTO outbox_messages (id, aggregate_id, partition_key, event_type, event_version, payload, occurred_at)
       VALUES ($1, 'a', 'w', 'WagerTransactionProcessed', 1, '{"a":1}', $2)
       RETURNING next_attempt_at <= now() AS due`,
      [uuid(), NOW],
    );

    expect(rows[0]?.due).toBe(true);
  });

  test('the json payload keeps its exact text', async () => {
    const id = uuid();
    const text = '{"b":1,"a":{"d":2,"c":3}}';

    await db.query(
      `INSERT INTO outbox_messages (id, aggregate_id, partition_key, event_type, event_version, payload, occurred_at)
       VALUES ($1, 'a', 'w', 'X', 1, $2, $3)`,
      [id, text, NOW],
    );
    const { rows } = await db.query<{ t: string }>(
      'SELECT payload::text AS t FROM outbox_messages WHERE id = $1',
      [id],
    );

    expect(rows[0]?.t).toBe(text);
  });

  test('the internal provider id is reserved', async () => {
    const error = await failure(`INSERT INTO providers (id, status) VALUES ('internal', 'ACTIVE')`);

    expect(error.constraint).toBe('providers_id_not_internal');
  });
});
