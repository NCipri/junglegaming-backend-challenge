// WagerTransactionPendingReference v1: the referenced transaction has not arrived yet.
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import { IntegrationEvent } from '../integration-event';
import type { EventMeta } from '../integration-event.types';
import type { WagerTransactionPendingReferenceData } from './event-data.types';

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  static readonly TYPE = 'WagerTransactionPendingReference';
  static readonly VERSION = 1;
  readonly eventType = WagerTransactionPendingReference.TYPE;
  readonly version = WagerTransactionPendingReference.VERSION;

  static from(tx: WagerTransaction, meta: EventMeta): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        expiresAt: tx.expiresAt?.toISOString() ?? null,
      },
    });
  }
}
