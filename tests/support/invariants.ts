import { expect } from 'bun:test';
import type { Client } from 'pg';

interface InvariantRow {
  balance: string;
  version: number;
  ledger_sum: string;
  entries: number;
  first_version: number | null;
  last_version: number | null;
  first_before: string | null;
  last_after: string | null;
  chain_breaks: number;
  missing_entries: number;
  orphan_entries: number;
}

export async function assertWalletInvariants(db: Client, walletId: string): Promise<void> {
  const { rows } = await db.query<InvariantRow>(
    `WITH e AS (
       SELECT wallet_version, direction, amount, balance_before, balance_after,
              LAG(wallet_version) OVER (ORDER BY wallet_version) AS prev_version,
              LAG(balance_after) OVER (ORDER BY wallet_version) AS prev_after
         FROM wallet_ledger_entries WHERE wallet_id = $1
     )
     SELECT w.balance::text AS balance,
            w.version,
            COALESCE((SELECT SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) FROM e), 0)
              ::numeric(19, 2)::text AS ledger_sum,
            (SELECT COUNT(*) FROM e)::int AS entries,
            (SELECT MIN(wallet_version) FROM e) AS first_version,
            (SELECT MAX(wallet_version) FROM e) AS last_version,
            (SELECT balance_before::text FROM e ORDER BY wallet_version LIMIT 1) AS first_before,
            (SELECT balance_after::text FROM e ORDER BY wallet_version DESC LIMIT 1) AS last_after,
            (SELECT COUNT(*) FROM e
              WHERE prev_version IS NOT NULL
                AND (wallet_version <> prev_version + 1 OR balance_before <> prev_after))::int
              AS chain_breaks,
            (SELECT COUNT(*) FROM wager_transactions t
              WHERE t.wallet_id = $1 AND t.status = 'PROCESSED' AND t.kind <> 'LOSS' AND t.amount > 0
                AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries l WHERE l.transaction_id = t.id))::int
              AS missing_entries,
            (SELECT COUNT(*) FROM wallet_ledger_entries l
               JOIN wager_transactions t ON t.id = l.transaction_id
              WHERE l.wallet_id = $1 AND (t.status <> 'PROCESSED' OR t.wallet_id <> l.wallet_id))::int
              AS orphan_entries
       FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  const row = rows[0];

  expect(row, `wallet ${walletId} exists`).toBeDefined();
  if (!row) {
    return;
  }
  expect(row.balance, `wallet ${walletId}: balance equals the ledger sum`).toBe(row.ledger_sum);
  expect(row.chain_breaks, `wallet ${walletId}: ledger chain is contiguous`).toBe(0);
  expect(
    row.missing_entries,
    `wallet ${walletId}: every balance-moving PROCESSED has an entry`,
  ).toBe(0);
  expect(
    row.orphan_entries,
    `wallet ${walletId}: every entry belongs to a PROCESSED transaction`,
  ).toBe(0);
  if (row.entries === 0) {
    expect(row.version, `wallet ${walletId}: version without entries`).toBe(1);

    return;
  }
  expect([1, 2], `wallet ${walletId}: chain starts at version 1 or 2`).toContain(
    row.first_version ?? -1,
  );
  expect(row.first_before, `wallet ${walletId}: chain starts from zero`).toBe('0.00');
  expect(row.last_version, `wallet ${walletId}: last entry matches the wallet version`).toBe(
    row.version,
  );
  expect(row.last_after, `wallet ${walletId}: last entry matches the stored balance`).toBe(
    row.balance,
  );
}

export async function assertAllWalletsInvariants(db: Client): Promise<number> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM wallets ORDER BY id');

  for (const { id } of rows) {
    await assertWalletInvariants(db, id);
  }

  return rows.length;
}
