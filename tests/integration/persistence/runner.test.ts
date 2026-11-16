import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { money, newWager, NOW, seedWallet, uuid } from '../../support/builders';
import { assertWalletInvariants } from '../../support/invariants';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import { waitUntil } from '../../support/wait-until';
import { classifyError } from '../../../src/infrastructure/db/error-classification';
import { TransientPersistenceError } from '../../../src/infrastructure/db/persistence.errors';
import type { TxContext } from '../../../src/infrastructure/db/tx-context';
import { InvalidTransactionStateError } from '../../../src/modules/wagering/domain/wager.errors';
import type { Wallet } from '../../../src/modules/wallet/domain/wallet';

let pg: TestPostgres;
let db: Client;
let admin: Client;
let t: TestOrm;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateUp(pg.migratorUrl);
  db = new Client({ connectionString: pg.migratorUrl });
  await db.connect();
  admin = new Client({ connectionString: pg.superuserUrl });
  await admin.connect();
  t = await createTestOrm(pg.appUrl);
}, 120_000);

afterAll(async () => {
  await t.close();
  await db.end();
  await admin.end();
  await pg.stop();
});

beforeEach(async () => {
  await resetDatabase(pg.migratorUrl);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

async function lockWaiters(): Promise<number> {
  const { rows } = await admin.query<{ waiting: number }>(
    `SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
      WHERE usename = 'app' AND wait_event_type = 'Lock'`,
  );

  return rows[0]?.waiting ?? 0;
}

async function debit(tx: TxContext, walletId: string, amount: string): Promise<Wallet> {
  const wallet = await tx.wallets.lockById(walletId);

  if (!wallet) {
    throw new Error('wallet not found');
  }
  const expectedVersion = wallet.version;
  const bet = newWager(wallet, { money: money(amount) });
  const entry = wallet.debit({ money: bet.money, transactionId: bet.id, entryId: uuid(), at: NOW });

  bet.markProcessed({ observedBalance: wallet.balance, at: NOW });
  await tx.wallets.saveBalance(wallet, expectedVersion);
  await tx.transactions.insert(bet);
  await tx.ledger.insert(entry);

  return wallet;
}

describe('WalletTransactionRunner — unique violations', () => {
  test('a (provider_id, idempotency_key) violation re-executes the unit instead of failing with 25P02', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const winner = newWager(seeded.wallet, { idempotencyKey: 'same-key' });

    winner.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: money('100.00'), at: NOW });
    await t.runner().run((tx) => tx.transactions.insert(winner));
    let executions = 0;

    const outcome = await t.runner().run(async (tx) => {
      executions += 1;
      if (executions === 1) {
        const loser = newWager(seeded.wallet, { idempotencyKey: 'same-key' });

        loser.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: money('100.00'), at: NOW });
        await tx.transactions.insert(loser);

        return 'inserted';
      }
      const existing = await tx.transactions.findByIdempotencyKey('provider-a', 'same-key');

      return existing?.id === winner.id ? 'replay' : 'unexpected';
    });

    expect(outcome).toBe('replay');
    expect(executions).toBe(2);
    expect(t.metrics.counter('processing_retries_total', { reason: 'UNIQUE_VIOLATION' })).toBe(1);
  });

  test('more than two unique re-executions become a TRANSIENT failure', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const winner = newWager(seeded.wallet, { idempotencyKey: 'dup' });

    winner.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: money('100.00'), at: NOW });
    await t.runner().run((tx) => tx.transactions.insert(winner));
    let executions = 0;
    const error = await failureOf(
      t.runner().run(async (tx) => {
        executions += 1;
        const loser = newWager(seeded.wallet, { idempotencyKey: 'dup' });

        loser.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: money('100.00'), at: NOW });
        await tx.transactions.insert(loser);
      }),
    );

    expect(executions).toBe(3);
    expect(error).toBeInstanceOf(TransientPersistenceError);
    expect(classifyError(error)).toEqual({ kind: 'TRANSIENT', reason: 'UNIQUE_RETRIES_EXHAUSTED' });
  });
});

describe('WalletTransactionRunner — serialization per wallet', () => {
  test('a second run on the same wallet waits for the first and sees its committed balance', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const firstLocked = deferred();
    const releaseFirst = deferred();
    const first = t.runner().run(async (tx) => {
      const wallet = await debit(tx, seeded.wallet.id, '10.00');

      firstLocked.resolve();
      await releaseFirst.promise;

      return wallet.balance.toJSON().amount;
    });

    await firstLocked.promise;
    let secondSawBefore = null as string | null;
    const second = t.runner().run(async (tx) => {
      const locked = await tx.wallets.lockById(seeded.wallet.id);

      secondSawBefore = locked?.balance.toJSON().amount ?? null;
      const wallet = await debit(tx, seeded.wallet.id, '10.00');

      return wallet.balance.toJSON().amount;
    });

    await waitUntil(async () => (await lockWaiters()) === 1, { timeoutMs: 5000 });
    expect(secondSawBefore).toBeNull();
    releaseFirst.resolve();

    expect(await first).toBe('90.00');
    expect(await second).toBe('80.00');
    expect(secondSawBefore).toBe('90.00');
    expect(t.metrics.allObservations('wallet_lock_wait_seconds').length).toBeGreaterThanOrEqual(3);
    await assertWalletInvariants(db, seeded.wallet.id);
  });
});

describe('WalletTransactionRunner — transient errors', () => {
  test('lock_timeout while another session holds the wallet → TRANSIENT after 3 attempts, metrics incremented', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const holder = new Client({ connectionString: pg.migratorUrl });

    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [seeded.wallet.id]);
    const conflictsBefore = t.metrics.counter('lock_conflicts_total');
    let attempts = 0;
    const startedAt = performance.now();

    try {
      const error = await failureOf(
        t.runner({ lockTimeoutMs: 100 }).run(async (tx) => {
          attempts += 1;

          return debit(tx, seeded.wallet.id, '10.00');
        }),
      );

      expect(attempts).toBe(3);
      expect(performance.now() - startedAt).toBeLessThan(1000);
      expect(error).toBeInstanceOf(TransientPersistenceError);
      expect(classifyError(error)).toEqual({ kind: 'TRANSIENT', reason: 'LOCK_TIMEOUT' });
      expect(t.metrics.counter('lock_conflicts_total') - conflictsBefore).toBe(3);
      expect(t.metrics.counter('processing_retries_total', { reason: 'LOCK_TIMEOUT' })).toBe(2);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect((await t.context().wallets.findById(seeded.wallet.id))?.balance.toJSON().amount).toBe(
      '100.00',
    );
    await assertWalletInvariants(db, seeded.wallet.id);
  });

  test('a transient failure followed by success commits once', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    let attempts = 0;

    const balance = await t.runner().run(async (tx) => {
      attempts += 1;
      const wallet = await debit(tx, seeded.wallet.id, '10.00');

      if (attempts === 1) {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }

      return wallet.balance.toJSON().amount;
    });

    expect(attempts).toBe(2);
    expect(balance).toBe('90.00');
    expect(t.metrics.counter('db_deadlocks_total')).toBeGreaterThanOrEqual(1);
    await assertWalletInvariants(db, seeded.wallet.id);
  });
});

describe('WalletTransactionRunner — deterministic errors and shutdown', () => {
  test('a deterministic error is rethrown immediately, without retry, and rolls back', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    let attempts = 0;
    const error = await failureOf(
      t.runner().run(async (tx) => {
        attempts += 1;
        await debit(tx, seeded.wallet.id, '10.00');
        throw new InvalidTransactionStateError('simulated bug');
      }),
    );

    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(InvalidTransactionStateError);
    expect((await t.context().wallets.findById(seeded.wallet.id))?.balance.toJSON().amount).toBe(
      '100.00',
    );
    await assertWalletInvariants(db, seeded.wallet.id);
  });

  test('a database CHECK violation (22003 overflow) is deterministic and not retried', async () => {
    const seeded = await t
      .runner()
      .run((tx) => seedWallet(tx, { balance: '99999999999999999.99' }));
    let attempts = 0;
    const error = await failureOf(
      t.runner().run(async (tx) => {
        attempts += 1;
        const wallet = await tx.wallets.lockById(seeded.wallet.id);

        if (!wallet) {
          throw new Error('wallet not found');
        }
        const expectedVersion = wallet.version;

        wallet.credit({ money: money('0.01'), transactionId: uuid(), entryId: uuid(), at: NOW });
        await tx.wallets.saveBalance(wallet, expectedVersion);
      }),
    );

    expect(attempts).toBe(1);
    expect(classifyError(error)).toEqual({ kind: 'DETERMINISTIC', reason: 'DATA_EXCEPTION_22003' });
  });

  test('an aborted signal kills the session, rolls back and does not retry', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const holder = new Client({ connectionString: pg.migratorUrl });
    const controller = new AbortController();

    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [seeded.wallet.id]);
    let attempts = 0;

    try {
      const running = failureOf(
        t.runner().run(
          async (tx) => {
            attempts += 1;

            return debit(tx, seeded.wallet.id, '10.00');
          },
          { signal: controller.signal },
        ),
      );

      await waitUntil(async () => (await lockWaiters()) === 1, { timeoutMs: 5000 });
      controller.abort();
      await running;
      await waitUntil(async () => (await lockWaiters()) === 0, { timeoutMs: 5000 });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }

    expect(attempts).toBe(1);
    expect((await t.context().wallets.findById(seeded.wallet.id))?.balance.toJSON().amount).toBe(
      '100.00',
    );
    expect(
      await failureOf(t.runner().run(() => Promise.resolve(1), { signal: controller.signal })),
    ).toBeInstanceOf(Error);
  });

  test('every attempt records its duration', async () => {
    const before = t.metrics.allObservations('db_transaction_duration_seconds').length;

    await t.runner().run((tx) => tx.providers.find('provider-a'));

    expect(t.metrics.allObservations('db_transaction_duration_seconds').length).toBe(before + 1);
  });
});
