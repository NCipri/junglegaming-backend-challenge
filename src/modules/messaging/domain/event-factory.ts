// Builds the outbox messages a transaction outcome must emit, partitioned by wallet.
import type { Clock } from '../../../shared/time/clock';
import type { IdGenerator } from '../../../shared/ids/id-generator';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { WagerStatus } from '../../wagering/domain/wager-status';
import type { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WagerTransactionFailed } from './events/wager-transaction-failed';
import { WagerTransactionPendingReference } from './events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from './events/wager-transaction-processed';
import { WagerTransactionRejected } from './events/wager-transaction-rejected';
import { WalletBalanceChanged } from './events/wallet-balance-changed';
import type { EventContext, EventMeta } from './integration-event.types';
import { InvalidMessageStateError } from './messaging.errors';
import { OutboxMessage } from './outbox-message';

export class EventFactory {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  forProcessed(
    tx: WagerTransaction,
    entry: WalletLedgerEntry | null,
    ctx: EventContext,
  ): OutboxMessage[] {
    this.assertStatus(tx, WagerStatus.Processed);
    if (tx.affectsBalance() && !entry) {
      throw new InvalidMessageStateError(
        `transaction ${tx.id} moved the balance without a ledger entry`,
      );
    }
    const messages = [
      OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, this.meta(ctx)), tx.walletId),
    ];

    if (entry) {
      messages.push(
        OutboxMessage.enqueue(WalletBalanceChanged.from(entry, this.meta(ctx)), tx.walletId),
      );
    }

    return messages;
  }

  forRejected(tx: WagerTransaction, ctx: EventContext): OutboxMessage[] {
    this.assertStatus(tx, WagerStatus.Rejected);

    return [
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(tx, this.failureCodeOf(tx), this.meta(ctx)),
        tx.walletId,
      ),
    ];
  }

  forPending(tx: WagerTransaction, ctx: EventContext): OutboxMessage[] {
    this.assertStatus(tx, WagerStatus.PendingReference);

    return [
      OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, this.meta(ctx)), tx.walletId),
    ];
  }

  forFailed(tx: WagerTransaction, ctx: EventContext): OutboxMessage[] {
    this.assertStatus(tx, WagerStatus.Failed);

    return [
      OutboxMessage.enqueue(
        WagerTransactionFailed.from(tx, this.failureCodeOf(tx), this.meta(ctx)),
        tx.walletId,
      ),
    ];
  }

  private meta(ctx: EventContext): EventMeta {
    return { ...ctx, eventId: this.ids.next(), occurredAt: this.clock.now() };
  }

  private failureCodeOf(tx: WagerTransaction) {
    if (!tx.failureCode) {
      throw new InvalidMessageStateError(`transaction ${tx.id} has no failure code`);
    }

    return tx.failureCode;
  }

  private assertStatus(tx: WagerTransaction, expected: WagerStatus): void {
    if (tx.status !== expected) {
      throw new InvalidMessageStateError(
        `transaction ${tx.id} is ${tx.status}, expected ${expected}`,
      );
    }
  }
}
