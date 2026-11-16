// WalletBalanceChanged v1: emitted only when a balance moves; walletVersion gives consumers a firm order.
import type { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry';
import { IntegrationEvent } from '../integration-event';
import type { EventMeta } from '../integration-event.types';
import type { WalletBalanceChangedData } from './event-data.types';

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  static readonly TYPE = 'WalletBalanceChanged';
  static readonly VERSION = 1;
  readonly eventType = WalletBalanceChanged.TYPE;
  readonly version = WalletBalanceChanged.VERSION;

  static from(entry: WalletLedgerEntry, meta: EventMeta): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...meta,
      aggregateId: entry.walletId,
      data: {
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
