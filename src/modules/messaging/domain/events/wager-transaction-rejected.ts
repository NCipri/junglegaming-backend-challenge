// WagerTransactionRejected v1: a business-rule rejection, including an expired pending reference.
import type { FailureCode } from '../../../wagering/domain/failure-code';
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import { IntegrationEvent } from '../integration-event';
import type { EventMeta } from '../integration-event.types';
import type { WagerTransactionRejectedData } from './event-data.types';

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  static readonly TYPE = 'WagerTransactionRejected';
  static readonly VERSION = 1;
  readonly eventType = WagerTransactionRejected.TYPE;
  readonly version = WagerTransactionRejected.VERSION;

  static from(
    tx: WagerTransaction,
    failureCode: FailureCode,
    meta: EventMeta,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
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
        balance: tx.observedBalance?.toJSON() ?? null,
        rejectedAt: (tx.processedAt ?? meta.occurredAt).toISOString(),
      },
    });
  }
}
