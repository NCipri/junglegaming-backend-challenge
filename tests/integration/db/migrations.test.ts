import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgres, type TestPostgres } from '../../support/containers';
import {
  APPLICATION_TABLES,
  existingApplicationTables,
  migrateDown,
  migrateUp,
  withClient,
} from '../../support/database';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);

afterAll(async () => {
  await pg.stop();
});

test('migrations run up, fully down and up again', async () => {
  await migrateUp(pg.migratorUrl);
  expect(await existingApplicationTables(pg.migratorUrl)).toEqual([...APPLICATION_TABLES].sort());

  await migrateDown(pg.migratorUrl);
  expect(await existingApplicationTables(pg.migratorUrl)).toEqual([]);

  await migrateUp(pg.migratorUrl);
  expect(await existingApplicationTables(pg.migratorUrl)).toEqual([...APPLICATION_TABLES].sort());
});

test('a single step down reverts only the latest migration', async () => {
  await migrateDown(pg.migratorUrl, 1);
  const providers = await withClient(pg.migratorUrl, async (client) => {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM providers ORDER BY id');

    return rows.map((row) => row.id);
  });

  expect(providers).toEqual([]);
  await migrateUp(pg.migratorUrl);
});

test('the seed migration registers the active providers', async () => {
  const providers = await withClient(pg.migratorUrl, async (client) => {
    const { rows } = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM providers ORDER BY id',
    );

    return rows;
  });

  expect(providers).toEqual([
    { id: 'provider-a', status: 'ACTIVE' },
    { id: 'provider-b', status: 'ACTIVE' },
  ]);
});

test('the schema is owned by migrator, not by app', async () => {
  const owners = await withClient(pg.superuserUrl, async (client) => {
    const { rows } = await client.query<{ tableowner: string }>(
      `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`,
    );

    return rows.map((row) => row.tableowner);
  });

  expect(owners).toEqual(['migrator']);
});
