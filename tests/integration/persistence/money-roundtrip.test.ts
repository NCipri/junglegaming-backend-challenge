import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { money, newWager, seedWallet } from '../../support/builders';
import { assertWalletInvariants } from '../../support/invariants';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import { WalletLedgerEntry } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { LedgerMapper } from '../../../src/modules/wallet/infrastructure/ledger.mapper';
import { WalletMapper } from '../../../src/modules/wallet/infrastructure/wallet.mapper';

const MAX = '99999999999999999.99';

let pg: TestPostgres;
let db: Client;
let t: TestOrm;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateUp(pg.migratorUrl);
  db = new Client({ connectionString: pg.migratorUrl });
  await db.connect();
  t = await createTestOrm(pg.appUrl);
}, 120_000);

afterAll(async () => {
  await t.close();
  await db.end();
  await pg.stop();
});

beforeEach(async () => {
  await resetDatabase(pg.migratorUrl);
});

describe('money round-trip through the persistence records', () => {
  test('the largest NUMERIC(19,2) balance survives write and read as an identical string', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: MAX }));
    const wallet = await t.context().wallets.findById(seeded.wallet.id);

    expect(wallet?.balance.toJSON()).toEqual({ amount: MAX, currency: 'BRL' });
    expect(typeof wallet?.balance.toJSON().amount).toBe('string');

    const { rows } = await db.query<{ balance: unknown }>(
      'SELECT balance FROM wallets WHERE id = $1',
      [seeded.wallet.id],
    );

    expect(typeof rows[0]?.balance).toBe('string');
    expect(rows[0]?.balance).toBe(MAX);
    await assertWalletInvariants(db, seeded.wallet.id);
  });

  test('the raw rows behind every monetary column stay strings', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: MAX }));
    const [raw] = await t.orm.em
      .fork()
      .execute<{ balance: unknown }[]>('SELECT balance FROM wallets WHERE id = ?', [
        seeded.wallet.id,
      ]);
    const record = WalletMapper.toRecord(seeded.wallet);
    const entryRecord = LedgerMapper.toRecord(seeded.entry as WalletLedgerEntry);
    const entries = await t.context().ledger.page(seeded.wallet.id, { limit: 10 });

    expect(typeof raw?.balance).toBe('string');
    expect(raw?.balance).toBe(MAX);
    expect(typeof record.balance).toBe('string');
    expect(record.balance).toBe(MAX);
    expect([entryRecord.amount, entryRecord.balanceBefore, entryRecord.balanceAfter]).toEqual([
      MAX,
      '0.00',
      MAX,
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.money.toJSON().amount).toBe(MAX);
    expect(entries[0]?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(entries[0]?.balanceAfter.toJSON().amount).toBe(MAX);
  });

  test('ledger entries, transactions and observed balances keep cents exactly', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '0.30' }));

    await t.runner().run(async (tx) => {
      const wallet = await tx.wallets.lockById(seeded.wallet.id);

      if (!wallet) {
        throw new Error('wallet not found');
      }
      const expectedVersion = wallet.version;
      const bet = newWager(wallet, { money: money('0.10') });
      const entry = wallet.debit({
        money: bet.money,
        transactionId: bet.id,
        entryId: Bun.randomUUIDv7(),
        at: bet.createdAt,
      });

      bet.markProcessed({ observedBalance: wallet.balance, at: bet.createdAt });
      await tx.wallets.saveBalance(wallet, expectedVersion);
      await tx.transactions.insert(bet);
      await tx.ledger.insert(entry);
    });

    const wallet = await t.context().wallets.findById(seeded.wallet.id);
    const [latest] = await t.context().ledger.page(seeded.wallet.id, { limit: 1 });

    expect(wallet?.balance.toJSON().amount).toBe('0.20');
    expect(latest).toBeInstanceOf(WalletLedgerEntry);
    expect(latest?.balanceBefore.toJSON().amount).toBe('0.30');
    expect(latest?.balanceAfter.toJSON().amount).toBe('0.20');
    expect(latest?.isBalanced()).toBe(true);
    await assertWalletInvariants(db, seeded.wallet.id);
  });
});
