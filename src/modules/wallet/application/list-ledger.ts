// ListLedger query: newest-first keyset pages over the wallet version with an opaque cursor.
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import { decodeCursor, encodeCursor } from './ledger-cursor';
import type { LedgerPage, ListLedgerParams } from './list-ledger.types';
import { toLedgerEntryView } from './wallet-view';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export class InvalidLimitError extends Error {
  readonly code = 'INVALID_LIMIT';

  constructor() {
    super('limit must be a positive integer');
    this.name = 'InvalidLimitError';
  }
}

export class ListLedger {
  constructor(private readonly runner: WalletTransactionRunner) {}

  async execute(walletId: string, p: ListLedgerParams = {}): Promise<LedgerPage> {
    const requested = p.limit ?? DEFAULT_LEDGER_LIMIT;

    if (!Number.isInteger(requested) || requested < 1) {
      throw new InvalidLimitError();
    }
    const limit = Math.min(requested, MAX_LEDGER_LIMIT);
    const beforeVersion = p.cursor === undefined ? undefined : decodeCursor(p.cursor);
    const entries = await this.runner.read((tx) =>
      tx.ledger.page(walletId, beforeVersion === undefined ? { limit } : { limit, beforeVersion }),
    );
    const last = entries.at(-1);
    const hasMore = entries.length === limit && last !== undefined && last.walletVersion > 1;

    return {
      items: entries.map(toLedgerEntryView),
      nextCursor: hasMore ? encodeCursor(last.walletVersion) : null,
    };
  }
}
