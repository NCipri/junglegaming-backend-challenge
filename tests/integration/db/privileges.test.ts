import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { DatabaseError } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase, withClient } from '../../support/database';

let pg: TestPostgres;
const NOW = '2026-11-15T12:00:00Z';

beforeAll(async () => {
  pg = await startPostgres();
  await migrateUp(pg.migratorUrl);
  await resetDatabase(pg.migratorUrl);
}, 120_000);

afterAll(async () => {
  await pg.stop();
});

async function asApp(sql: string, params: unknown[] = []): Promise<DatabaseError | null> {
  return withClient(pg.appUrl, async (client) => {
    try {
      await client.query(sql, params);

      return null;
    } catch (error) {
      return error as DatabaseError;
    }
  });
}

test('app may read, insert and update wallets', async () => {
  const id = Bun.randomUUIDv7();

  expect(
    await asApp(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', '0.00', 1, $3, $3)`,
      [id, Bun.randomUUIDv7(), NOW],
    ),
  ).toBeNull();
  expect(
    await asApp(`UPDATE wallets SET balance = '1.00', version = 2 WHERE id = $1`, [id]),
  ).toBeNull();
  expect(await asApp('SELECT * FROM wallets')).toBeNull();
});

test.each([
  ['UPDATE the ledger', `UPDATE wallet_ledger_entries SET amount = '1.00'`],
  ['DELETE from the ledger', 'DELETE FROM wallet_ledger_entries'],
  ['INSERT a provider', `INSERT INTO providers (id, status) VALUES ('provider-x', 'ACTIVE')`],
  ['DELETE a wallet', 'DELETE FROM wallets'],
  ['DELETE a transaction', 'DELETE FROM wager_transactions'],
  ['TRUNCATE the outbox', 'TRUNCATE outbox_messages'],
  ['create a table', 'CREATE TABLE intruder (x int)'],
])('app may not %s', async (_, sql) => {
  const error = await asApp(sql);

  expect(error?.code).toBe('42501');
});

test('app may read providers and insert ledger, inbox and outbox rows', async () => {
  expect(await asApp('SELECT * FROM providers')).toBeNull();
  expect(await asApp('SELECT * FROM wallet_ledger_entries')).toBeNull();
  expect(
    await asApp(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES ('c', 'm', $1, $2)`,
      ['a'.repeat(64), NOW],
    ),
  ).toBeNull();
});
