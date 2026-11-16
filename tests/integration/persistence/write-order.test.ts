import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { NOW, newWager, seedWallet, uuid } from '../../support/builders';
import { assertWalletInvariants } from '../../support/invariants';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import { EventFactory } from '../../../src/modules/messaging/domain/event-factory';

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

const WRITE = /^\s*(update|insert)\s+(?:into\s+)?"?(\w+)"?/i;

function writesIn(queries: string[]): string[] {
  return queries.flatMap((sql) => {
    const match = WRITE.exec(sql.replace(/^\[query\]\s*/, ''));

    return match ? [`${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`] : [];
  });
}

describe('write order inside the transaction', () => {
  test('processing a BET emits UPDATE wallets → INSERT wager_transactions → INSERT ledger → INSERT outbox, each before COMMIT', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const events = new EventFactory({ next: uuid }, { now: () => NOW });
    const start = t.queries.length;

    await t.runner().run(async (tx) => {
      const wallet = await tx.wallets.lockById(seeded.wallet.id);

      if (!wallet) {
        throw new Error('wallet not found');
      }
      const expectedVersion = wallet.version;
      const bet = newWager(wallet);
      const entry = wallet.debit({
        money: bet.money,
        transactionId: bet.id,
        entryId: uuid(),
        at: NOW,
      });

      bet.markProcessed({ observedBalance: wallet.balance, at: NOW });
      await tx.wallets.saveBalance(wallet, expectedVersion);
      await tx.transactions.insert(bet);
      await tx.ledger.insert(entry);
      await tx.transactions.accelerateDependents(bet.providerId, bet.externalTransactionId, NOW);
      await tx.outbox.insertMany(
        events.forProcessed(bet, entry, { correlationId: bet.correlationId }),
      );
    });
    const emitted = t.queries.slice(start);
    const commitAt = emitted.findIndex((sql) => /\bcommit\b/i.test(sql));
    const lockAt = emitted.findIndex((sql) => /for update/i.test(sql) && /wallets/i.test(sql));

    expect(writesIn(emitted)).toEqual([
      'UPDATE wallets',
      'INSERT wager_transactions',
      'INSERT wallet_ledger_entries',
      'UPDATE wager_transactions',
      'INSERT outbox_messages',
    ]);
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(lockAt);
    const lastWriteAt = emitted.findLastIndex((sql) =>
      WRITE.test(sql.replace(/^\[query\]\s*/, '')),
    );

    expect(lastWriteAt).toBeLessThan(commitAt);
    await assertWalletInvariants(db, seeded.wallet.id);
  });

  test('each transaction sets the three server-side timeouts transaction-locally, right after BEGIN', async () => {
    const start = t.queries.length;

    await t.runner({ lockTimeoutMs: 1234 }).run((tx) => tx.providers.find('provider-a'));
    const emitted = t.queries.slice(start);
    const beginAt = emitted.findIndex((sql) => /\bbegin\b/i.test(sql));
    const settings = emitted[beginAt + 1] ?? '';

    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(settings).toContain("set_config('lock_timeout', '1234ms', true)");
    expect(settings).toContain("set_config('statement_timeout', '10000ms', true)");
    expect(settings).toContain(
      "set_config('idle_in_transaction_session_timeout', '30000ms', true)",
    );
  });

  test('reconciliationSnapshot of a wallet without entries reports calculated "0.00"', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '0.00' }));

    expect(await t.context().ledger.reconciliationSnapshot(seeded.wallet.id)).toEqual({
      stored: '0.00',
      walletVersion: 1,
      calculated: '0.00',
      entries: 0,
      chainIntact: true,
      firstBrokenVersion: null,
    });
  });
});
