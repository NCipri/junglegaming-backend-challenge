import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { uuid } from '../../support/builders';
import { assertAllWalletsInvariants } from '../../support/invariants';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import { createUseCases, type UseCases } from '../../support/use-cases';

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

async function count(table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );

  return rows[0]?.n ?? 0;
}

describe('OpenWallet', () => {
  test('a positive initial balance creates the wallet, a PROCESSED OPENING, one CREDIT entry and two events', async () => {
    const playerId = uuid();
    const result = await app.openWallet.execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: 'corr-open',
    });

    if (result.type !== 'CREATED') {
      throw new Error('expected CREATED');
    }
    expect(result.wallet).toEqual({
      id: result.wallet.id,
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const { rows: opening } = await db.query<{ provider_id: string; status: string; kind: string }>(
      'SELECT provider_id, status, kind FROM wager_transactions WHERE wallet_id = $1',
      [result.wallet.id],
    );
    const { rows: entries } = await db.query<{ direction: string; wallet_version: number }>(
      'SELECT direction, wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1',
      [result.wallet.id],
    );

    expect(opening).toEqual([{ provider_id: 'internal', status: 'PROCESSED', kind: 'OPENING' }]);
    expect(entries).toEqual([{ direction: 'CREDIT', wallet_version: 1 }]);
    expect(await count('outbox_messages', 'partition_key = $1', [result.wallet.id])).toBe(2);
  });

  test('a zero initial balance creates only the wallet', async () => {
    const result = await app.openWallet.execute({
      playerId: uuid(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
      correlationId: 'corr-open',
    });

    expect(result.type).toBe('CREATED');
    expect(await count('wallets')).toBe(1);
    expect(await count('wager_transactions')).toBe(0);
    expect(await count('wallet_ledger_entries')).toBe(0);
    expect(await count('outbox_messages')).toBe(0);
  });

  test('a duplicate (player, currency) returns ALREADY_EXISTS with the existing id', async () => {
    const playerId = uuid();
    const cmd = {
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
      correlationId: 'corr-open',
    };
    const first = await app.openWallet.execute(cmd);
    const second = await app.openWallet.execute(cmd);

    if (first.type !== 'CREATED') {
      throw new Error('expected CREATED');
    }
    expect(second).toEqual({ type: 'ALREADY_EXISTS', walletId: first.wallet.id });
    expect(await count('wallets')).toBe(1);
  });

  test('concurrent duplicates create exactly one wallet', async () => {
    const playerId = uuid();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.openWallet.execute({
          playerId,
          initialBalance: { amount: '10.00', currency: 'BRL' },
          correlationId: 'corr-open',
        }),
      ),
    );

    expect(results.filter((r) => r.type === 'CREATED')).toHaveLength(1);
    expect(await count('wallets')).toBe(1);
    expect(await count('wallet_ledger_entries')).toBe(1);
  });

  test('the same player may hold wallets in different currencies', async () => {
    const playerId = uuid();

    await app.openWallet.execute({
      playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
      correlationId: 'c',
    });
    const usd = await app.openWallet.execute({
      playerId,
      initialBalance: { amount: '1.00', currency: 'USD' },
      correlationId: 'c',
    });

    expect(usd.type).toBe('CREATED');
    expect(await count('wallets')).toBe(2);
  });
});
