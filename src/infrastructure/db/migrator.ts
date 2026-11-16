// Programmatic migration runner: up to latest, or down by N steps (all when omitted).
import { MikroORM } from '@mikro-orm/postgresql';
import { migrationOrmConfig } from './mikro-orm.config';

async function withMigrator(
  clientUrl: string,
  work: (orm: MikroORM) => Promise<void>,
): Promise<void> {
  const orm = await MikroORM.init(migrationOrmConfig(clientUrl));

  try {
    await work(orm);
  } finally {
    await orm.close(true);
  }
}

export async function migrateUp(clientUrl: string): Promise<void> {
  await withMigrator(clientUrl, async (orm) => {
    await orm.migrator.up();
  });
}

export async function migrateDown(clientUrl: string, steps?: number): Promise<void> {
  await withMigrator(clientUrl, async (orm) => {
    if (steps === undefined) {
      await orm.migrator.down({ to: 0 });

      return;
    }
    for (let step = 0; step < steps; step++) {
      await orm.migrator.down();
    }
  });
}
