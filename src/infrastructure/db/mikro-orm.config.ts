// MikroORM options for the migration runner (connects as the schema owner, migrator).
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrationsList } from './migrations';

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
