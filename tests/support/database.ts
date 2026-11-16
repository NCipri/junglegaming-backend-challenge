import { Client } from 'pg';
import { migrateDown, migrateUp } from '../../src/infrastructure/db/migrator';

export { migrateDown, migrateUp };

export const APPLICATION_TABLES = [
  'outbox_messages',
  'inbox_messages',
  'wallet_ledger_entries',
  'wager_transactions',
  'wallets',
  'providers',
] as const;

export async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });

  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function resetDatabase(migratorUrl: string): Promise<void> {
  await withClient(migratorUrl, async (client) => {
    await client.query(`TRUNCATE ${APPLICATION_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query(
      `INSERT INTO providers (id, status) VALUES
         ('provider-a', 'ACTIVE'), ('provider-b', 'ACTIVE'), ('provider-inactive', 'INACTIVE')`,
    );
  });
}

export async function existingApplicationTables(url: string): Promise<string[]> {
  return withClient(url, async (client) => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [APPLICATION_TABLES],
    );

    return rows.map((row) => row.table_name);
  });
}
