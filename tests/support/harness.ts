import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { Client } from 'pg';
import { startPostgres, type TestPostgres } from './containers';
import { migrateUp, resetDatabase } from './database';
import { uuid } from './builders';
import { assertAllWalletsInvariants } from './invariants';
import { createTestOrm, type TestOrm } from './persistence';
import { createUseCases, type UseCases } from './use-cases';
import type { WalletView } from '../../src/modules/wallet/application/wallet-view';

export interface UseCaseHarness {
  pg: TestPostgres;
  db: Client;
  t: TestOrm;
  app: UseCases;
  openWallet(amount: string): Promise<WalletView>;
  count(table: string, where?: string, params?: unknown[]): Promise<number>;
}

export const REPEAT = Math.max(1, Number.parseInt(process.env.REPEAT ?? '1', 10) || 1);

export function repeated(name: string): string[] {
  return Array.from({ length: REPEAT }, (_, i) => (REPEAT === 1 ? name : `${name} #${i + 1}`));
}

export function useCaseHarness(): UseCaseHarness {
  const h = {} as UseCaseHarness;

  beforeAll(async () => {
    h.pg = await startPostgres();
    await migrateUp(h.pg.migratorUrl);
    h.db = new Client({ connectionString: h.pg.migratorUrl });
    await h.db.connect();
    h.t = await createTestOrm(h.pg.appUrl);
    h.app = createUseCases(h.t);
  }, 120_000);

  afterAll(async () => {
    await h.t.close();
    await h.db.end();
    await h.pg.stop();
  });

  beforeEach(async () => {
    await resetDatabase(h.pg.migratorUrl);
  });

  afterEach(async () => {
    await assertAllWalletsInvariants(h.db);
  });

  h.openWallet = async (amount: string) => {
    const result = await h.app.openWallet.execute({
      playerId: uuid(),
      initialBalance: { amount, currency: 'BRL' },
      correlationId: 'corr-open',
    });

    if (result.type !== 'CREATED') {
      throw new Error('expected CREATED');
    }

    return result.wallet;
  };

  h.count = async (table: string, where = 'TRUE', params: unknown[] = []) => {
    const { rows } = await h.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );

    return rows[0]?.n ?? 0;
  };

  return h;
}
