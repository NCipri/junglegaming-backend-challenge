import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { hashOf, uuid } from '../../support/builders';
import { assertAllWalletsInvariants } from '../../support/invariants';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import {
  createUseCases,
  ThrowingFaultInjector,
  wagerCommand,
  type UseCases,
} from '../../support/use-cases';

let pg: TestPostgres;
let db: Client;
let t: TestOrm;
let app: UseCases;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateUp(pg.migratorUrl);
  db = new Client({ connectionString: pg.migratorUrl });
  await db.connect();
  t = await createTestOrm(pg.appUrl);
  app = createUseCases(t);
}, 120_000);

afterAll(async () => {
  await t.close();
  await db.end();
  await pg.stop();
});

beforeEach(async () => {
  await resetDatabase(pg.migratorUrl);
});

afterEach(async () => {
  await assertAllWalletsInvariants(db);
});

async function openWallet(amount: string) {
  const result = await app.openWallet.execute({
    playerId: uuid(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });

  if (result.type !== 'CREATED') {
    throw new Error('expected CREATED');
  }

  return result.wallet;
}

async function counts(): Promise<Record<string, number>> {
  const { rows } = await db.query<Record<string, number>>(
    `SELECT (SELECT COUNT(*) FROM wager_transactions)::int AS transactions,
            (SELECT COUNT(*) FROM wallet_ledger_entries)::int AS ledger,
            (SELECT COUNT(*) FROM inbox_messages)::int AS inbox,
            (SELECT COUNT(*) FROM outbox_messages)::int AS outbox`,
  );

  return rows[0] ?? {};
}

describe('atomicity across wallet, ledger, inbox and outbox', () => {
  test('a crash after the ledger insert (before the outbox) leaves nothing behind on the SQS channel', async () => {
    const wallet = await openWallet('100.00');
    const before = await counts();
    const faulty = createUseCases(t, { faults: new ThrowingFaultInjector('after-ledger-insert') });
    const cmd = wagerCommand(wallet);

    let failed = false;

    try {
      await faulty.processWager.execute(cmd, {
        type: 'SQS',
        consumerName: 'wager-consumer',
        messageId: uuid(),
        messageHash: hashOf('h'),
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    const wallet2 = await app.getWallet.execute(wallet.id);

    expect(wallet2?.balance.amount).toBe('100.00');
    expect(wallet2?.version).toBe(1);
    expect(await counts()).toEqual(before);
  });

  test('a crash right before commit leaves nothing behind on the HTTP channel', async () => {
    const wallet = await openWallet('100.00');
    const before = await counts();
    const faulty = createUseCases(t, { faults: new ThrowingFaultInjector('before-commit') });
    let failed = false;

    try {
      await faulty.processWager.execute(wagerCommand(wallet), { type: 'HTTP' });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    expect(await counts()).toEqual(before);
    expect((await app.getWallet.execute(wallet.id))?.balance.amount).toBe('100.00');
  });
});

describe('ReconcileWallet', () => {
  test('a consistent wallet reconciles with difference 0.00', async () => {
    const wallet = await openWallet('100.00');

    await app.processWager.execute(wagerCommand(wallet), { type: 'HTTP' });

    expect(await app.reconcile.execute(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
      chainIntact: true,
      firstBrokenVersion: null,
    });
  });

  test('a tampered balance is reported, logged and counted, never corrected', async () => {
    const wallet = await openWallet('100.00');
    const before = t.metrics.counter('reconciliation_divergence_total');

    await db.query('UPDATE wallets SET balance = balance + 5.00 WHERE id = $1', [wallet.id]);
    const report = await app.reconcile.execute(wallet.id);

    expect(report).toMatchObject({
      consistent: false,
      storedBalance: { amount: '105.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '5.00', currency: 'BRL' },
    });
    expect(t.metrics.counter('reconciliation_divergence_total') - before).toBe(1);
    expect(app.logger.errors.at(-1)?.context).toMatchObject({ walletId: wallet.id });
    expect((await app.getWallet.execute(wallet.id))?.balance.amount).toBe('105.00');
    await db.query('UPDATE wallets SET balance = balance - 5.00 WHERE id = $1', [wallet.id]);
  });

  test('an unknown wallet reconciles to null', async () => {
    expect(await app.reconcile.execute(uuid())).toBeNull();
  });
});
