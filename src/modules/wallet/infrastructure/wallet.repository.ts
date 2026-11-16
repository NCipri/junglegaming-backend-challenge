// Wallet repository: the only wallet row lock in the codebase (lockById) and explicit version-checked writes.
import type { EntityManager } from '@mikro-orm/postgresql';
import { VersionConflictError } from '../../../infrastructure/db/persistence.errors';
import { selectList, type SelectedRow } from '../../../infrastructure/db/sql-columns';
import type { MetricsPort } from '../../observability/metrics.port';
import type { Wallet } from '../domain/wallet';
import { WalletMapper } from './wallet.mapper';
import { WALLET_COLUMNS, WalletRecordSchema, type WalletRecord } from './wallet.record';

const SELECT = `SELECT ${selectList(WALLET_COLUMNS)} FROM wallets`;

export class WalletRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort,
  ) {}

  async lockById(id: string): Promise<Wallet | null> {
    const startedAt = performance.now();

    try {
      return await this.one(`${SELECT} WHERE id = ? FOR UPDATE`, [id]);
    } finally {
      this.metrics.observe('wallet_lock_wait_seconds', (performance.now() - startedAt) / 1000);
    }
  }

  findById(id: string): Promise<Wallet | null> {
    return this.one(`${SELECT} WHERE id = ?`, [id]);
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return this.one(`${SELECT} WHERE player_id = ? AND currency = ?`, [playerId, currency]);
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecordSchema, WalletMapper.toRecord(wallet));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const record = WalletMapper.toRecord(wallet);
    const affected = await this.em.nativeUpdate(
      WalletRecordSchema,
      { id: record.id, version: expectedVersion },
      { balance: record.balance, version: record.version, updatedAt: record.updatedAt },
    );

    if (affected !== 1) {
      throw new VersionConflictError('wallets', wallet.id);
    }
  }

  private async one(sql: string, params: unknown[]): Promise<Wallet | null> {
    const rows = await this.em.execute<SelectedRow<WalletRecord>[]>(sql, params);
    const row = rows[0];

    return row ? WalletMapper.toDomain(row) : null;
  }
}
