// MikroORM options: the migration runner (schema owner, migrator) and the runtime app connection (D-012, D-059).
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ProviderRecordSchema } from '../../modules/identity/provider.record';
import { InboxMessageRecordSchema } from '../../modules/messaging/infrastructure/records/inbox-message.record';
import { OutboxMessageRecordSchema } from '../../modules/messaging/infrastructure/records/outbox-message.record';
import { WagerTransactionRecordSchema } from '../../modules/wagering/infrastructure/wager-transaction.record';
import { LedgerEntryRecordSchema } from '../../modules/wallet/infrastructure/ledger-entry.record';
import { WalletRecordSchema } from '../../modules/wallet/infrastructure/wallet.record';
import { migrationsList } from './migrations';
import type { AppOrmOptions } from './mikro-orm.config.types';

export type { AppOrmOptions } from './mikro-orm.config.types';

export const PERSISTENCE_RECORDS = [
  WalletRecordSchema,
  LedgerEntryRecordSchema,
  WagerTransactionRecordSchema,
  InboxMessageRecordSchema,
  OutboxMessageRecordSchema,
  ProviderRecordSchema,
];

export function migrationOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}

export function appOrmConfig(options: AppOrmOptions) {
  const { onQuery } = options;

  return defineConfig({
    clientUrl: options.clientUrl,
    entities: PERSISTENCE_RECORDS,
    pool: { min: 0, max: options.poolSize },
    driverOptions: {
      connectionTimeoutMillis: Math.min(options.connectTimeoutMs, options.acquireTimeoutMs),
      query_timeout: options.queryTimeoutMs,
    },
    allowGlobalContext: false,
    colors: false,
    debug: onQuery ? ['query'] : false,
    ...(onQuery ? { logger: onQuery } : {}),
  });
}
