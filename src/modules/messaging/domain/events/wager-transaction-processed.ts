// WagerTransactionProcessed v1: any applied transaction, including LOSS and zero amounts.
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import { IntegrationEvent } from '../integration-event';
import type { EventMeta } from '../integration-event.types';
import type { WagerTransactionProcessedData } from './event-data.types';

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  static readonly TYPE = 'WagerTransactionProcessed';
  static readonly VERSION = 1;
  readonly eventType = WagerTransactionProcessed.TYPE;
  readonly version = WagerTransactionProcessed.VERSION;

  static from(tx: WagerTransaction, meta: EventMeta): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...meta,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        status: tx.status,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balance: tx.observedBalance?.toJSON() ?? null,
        processedAt: (tx.processedAt ?? meta.occurredAt).toISOString(),
      },
    });
  }
}
