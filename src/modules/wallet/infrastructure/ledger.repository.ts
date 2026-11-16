// Ledger repository: insert-only entries, keyset pages and the single-query reconciliation snapshot (D-057).
import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { selectList, type SelectedRow } from '../../../infrastructure/db/sql-columns';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { LedgerMapper } from './ledger.mapper';
import {
  LEDGER_ENTRY_COLUMNS,
  LedgerEntryRecordSchema,
  type LedgerEntryRecord,
} from './ledger-entry.record';
import type { ReconciliationSnapshot } from './ledger.repository.types';

const SELECT = `SELECT ${selectList(LEDGER_ENTRY_COLUMNS)} FROM wallet_ledger_entries`;

const RECONCILIATION_SQL = `
  WITH w AS (
    SELECT balance, version FROM wallets WHERE id = ?
  ),
  e AS (
    SELECT wallet_version, direction, amount, balance_before, balance_after,
           LAG(wallet_version) OVER (ORDER BY wallet_version) AS prev_version,
           LAG(balance_after) OVER (ORDER BY wallet_version) AS prev_after,
           ROW_NUMBER() OVER (ORDER BY wallet_version) AS position
      FROM wallet_ledger_entries
     WHERE wallet_id = ?
  ),
  breaks AS (
    SELECT MIN(wallet_version) AS version
      FROM e
     WHERE (position = 1 AND (wallet_version NOT IN (1, 2) OR balance_before <> 0))
        OR (position > 1 AND (wallet_version <> prev_version + 1 OR balance_before <> prev_after))
  ),
  totals AS (
    SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19, 2)
             AS calculated,
           COUNT(*)::int AS entries,
           MAX(wallet_version) AS last_version
      FROM e
  )
  SELECT w.balance::text AS stored,
         w.version AS "walletVersion",
         totals.calculated::text AS calculated,
         totals.entries,
         COALESCE(
           (SELECT version FROM breaks),
           CASE
             WHEN totals.entries = 0 AND w.version <> 1 THEN 1
             WHEN totals.entries > 0 AND totals.last_version <> w.version THEN totals.last_version + 1
           END
         ) AS "firstBrokenVersion"
    FROM w CROSS JOIN totals
`;

interface SnapshotRow {
  stored: string;
  walletVersion: number;
  calculated: string;
  entries: number;
  firstBrokenVersion: number | null;
}

export class LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecordSchema, LedgerMapper.toRecord(entry));
  }

  async page(
    walletId: string,
    p: { beforeVersion?: number; limit: number },
  ): Promise<WalletLedgerEntry[]> {
    const rows =
      p.beforeVersion === undefined
        ? await this.em.execute<SelectedRow<LedgerEntryRecord>[]>(
            `${SELECT} WHERE wallet_id = ? ORDER BY wallet_version DESC LIMIT ?`,
            [walletId, p.limit],
          )
        : await this.em.execute<SelectedRow<LedgerEntryRecord>[]>(
            `${SELECT} WHERE wallet_id = ? AND wallet_version < ? ORDER BY wallet_version DESC LIMIT ?`,
            [walletId, p.beforeVersion, p.limit],
          );

    return rows.map((row) => LedgerMapper.toDomain(row));
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    const rows = await this.em
      .fork()
      .transactional((em) => em.execute<SnapshotRow[]>(RECONCILIATION_SQL, [walletId, walletId]), {
        isolationLevel: IsolationLevel.REPEATABLE_READ,
        readOnly: true,
      });
    const row = rows[0];

    if (!row) {
      return null;
    }

    return {
      stored: row.stored,
      walletVersion: row.walletVersion,
      calculated: row.calculated,
      entries: row.entries,
      chainIntact: row.firstBrokenVersion === null,
      firstBrokenVersion: row.firstBrokenVersion,
    };
  }
}
