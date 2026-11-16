import { MikroORM } from '@mikro-orm/postgresql';
import { appOrmConfig } from '../../src/infrastructure/db/mikro-orm.config';
import { createTxContext, type TxContext } from '../../src/infrastructure/db/tx-context';
import {
  WalletTransactionRunner,
  type RunnerSettings,
} from '../../src/infrastructure/db/wallet-transaction-runner';
import { InMemoryMetrics } from './metrics';

export interface TestOrm {
  orm: MikroORM;
  metrics: InMemoryMetrics;
  queries: string[];
  runner(overrides?: Partial<RunnerSettings>): WalletTransactionRunner;
  context(): TxContext;
  close(): Promise<void>;
}

export const TEST_RUNNER_SETTINGS: RunnerSettings = {
  lockTimeoutMs: 5000,
  statementTimeoutMs: 10000,
  idleInTxTimeoutMs: 30000,
  retryBaseMs: 1,
  retryCapMs: 5,
};

export async function createTestOrm(appUrl: string): Promise<TestOrm> {
  const queries: string[] = [];
  const metrics = new InMemoryMetrics();
  const orm = await MikroORM.init(
    appOrmConfig({
      clientUrl: appUrl,
      poolSize: 10,
      connectTimeoutMs: 5000,
      acquireTimeoutMs: 5000,
      queryTimeoutMs: 15000,
      onQuery: (sql) => {
        queries.push(sql);
      },
    }),
  );

  return {
    orm,
    metrics,
    queries,
    runner: (overrides = {}) =>
      new WalletTransactionRunner(orm.em, metrics, { ...TEST_RUNNER_SETTINGS, ...overrides }),
    context: () => createTxContext(orm.em.fork(), metrics),
    close: async () => {
      await orm.close(true);
    },
  };
}
