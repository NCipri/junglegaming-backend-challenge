// WagerTransactionFailed v1: a terminal unexpected processing failure (addition to the README minimum).
import type { FailureCode } from '../../../wagering/domain/failure-code';
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import { IntegrationEvent } from '../integration-event';
import type { EventMeta } from '../integration-event.types';
import type { WagerTransactionFailedData } from './event-data.types';

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  static readonly TYPE = 'WagerTransactionFailed';
  static readonly VERSION = 1;
  readonly eventType = WagerTransactionFailed.TYPE;
  readonly version = WagerTransactionFailed.VERSION;

  static from(
    tx: WagerTransaction,
    failureCode: FailureCode,
    meta: EventMeta,
  ): WagerTransactionFailed {
    return new WagerTransactionFailed({
      ...meta,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        status: tx.status,
        money: tx.money.toJSON(),
        failureCode,
        failedAt: (tx.processedAt ?? meta.occurredAt).toISOString(),
      },
    });
  }
}
