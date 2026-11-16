// Shared decide-and-write core under the wallet lock, in the fixed write order: wallet, transaction, ledger, dependents, outbox.
import type { FaultInjector } from '../../../infrastructure/fault/fault-injector';
import type { TxContext } from '../../../infrastructure/db/tx-context';
import type { IdGenerator } from '../../../shared/ids/id-generator';
import type { Money } from '../../../shared/money/money';
import type { Clock } from '../../../shared/time/clock';
import type { EventFactory } from '../../messaging/domain/event-factory';
import type { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { MetricsPort } from '../../observability/metrics.port';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { FailureCode } from '../domain/failure-code';
import { decideWager } from '../domain/wager-rules';
import type { ReferenceContext, WagerDecision } from '../domain/wager-rules.types';
import { WagerStatus } from '../domain/wager-status';
import type { WagerTransaction } from '../domain/wager-transaction';
import { InvalidTransactionStateError } from '../domain/wager.errors';
import type { ProcessContext, WagerProcessorSettings } from './wager-processor.types';
import { toTransactionView, type TransactionView } from './wager-result';

export class WagerProcessor {
  constructor(
    private readonly events: EventFactory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: MetricsPort,
    private readonly faults: FaultInjector,
    private readonly settings: WagerProcessorSettings,
  ) {}

  async processLocked(
    tx: TxContext,
    pending: WagerTransaction,
    ctx: ProcessContext,
  ): Promise<TransactionView> {
    const isNew = pending.status === WagerStatus.Pending;
    const provider = await tx.providers.find(pending.providerId);
    const reference = await this.referenceOf(tx, pending);
    const decision = decideWager({ transaction: pending, provider, wallet: ctx.wallet, reference });
    const now = this.clock.now();
    const observed = this.observedBalance(ctx.wallet, decision);
    let entry: WalletLedgerEntry | null = null;
    let expectedVersion: number | null = null;

    if (decision.type === 'APPLY') {
      if (!ctx.wallet) {
        throw new InvalidTransactionStateError('a transaction cannot apply without a wallet');
      }
      if (decision.direction) {
        expectedVersion = ctx.wallet.version;
        entry = this.move(ctx.wallet, pending, decision.direction, now);
      }
      pending.markProcessed({
        ...(decision.referenceTransactionId
          ? { referenceTransactionId: decision.referenceTransactionId }
          : {}),
        observedBalance: ctx.wallet.balance,
        at: now,
      });
    } else if (decision.type === 'REJECT') {
      pending.reject({ code: decision.code, observedBalance: observed, at: now });
    } else if (isNew) {
      pending.markPendingReference({
        observedBalance: observed,
        nextAttemptAt: new Date(now.getTime() + this.settings.pendingFirstRetryMs),
        expiresAt: new Date(now.getTime() + this.settings.pendingTtlMs),
      });
    } else {
      return toTransactionView(pending);
    }

    if (ctx.wallet && expectedVersion !== null) {
      await tx.wallets.saveBalance(ctx.wallet, expectedVersion);
    }
    if (isNew) {
      await tx.transactions.insert(pending);
    } else {
      await tx.transactions.update(pending);
    }
    if (entry) {
      await tx.ledger.insert(entry);
    }
    await this.faults.hit('after-ledger-insert');
    if (pending.status !== WagerStatus.PendingReference) {
      await tx.transactions.accelerateDependents(
        pending.providerId,
        pending.externalTransactionId,
        now,
      );
    }
    await tx.outbox.insertMany(this.eventsFor(pending, entry, ctx));
    this.metrics.increment('wager_transactions_total', {
      status: pending.status,
      kind: pending.kind,
    });

    return toTransactionView(pending);
  }

  async failLocked(
    tx: TxContext,
    pending: WagerTransaction,
    ctx: ProcessContext,
    at: Date,
  ): Promise<TransactionView> {
    pending.fail({ code: FailureCode.UnexpectedProcessingError, at });
    await tx.transactions.update(pending);
    await tx.transactions.accelerateDependents(
      pending.providerId,
      pending.externalTransactionId,
      at,
    );
    await tx.outbox.insertMany(this.eventsFor(pending, null, ctx));
    this.metrics.increment('wager_transactions_total', {
      status: pending.status,
      kind: pending.kind,
    });

    return toTransactionView(pending);
  }

  async rejectExpired(
    tx: TxContext,
    pending: WagerTransaction,
    ctx: ProcessContext,
    at: Date,
  ): Promise<TransactionView> {
    pending.reject({
      code: FailureCode.ReferenceNotFound,
      observedBalance: this.observedBalance(ctx.wallet, {
        type: 'REJECT',
        code: FailureCode.ReferenceNotFound,
      }),
      at,
    });
    await tx.transactions.update(pending);
    await tx.transactions.accelerateDependents(
      pending.providerId,
      pending.externalTransactionId,
      at,
    );
    await tx.outbox.insertMany(this.eventsFor(pending, null, ctx));
    this.metrics.increment('wager_transactions_total', {
      status: pending.status,
      kind: pending.kind,
    });

    return toTransactionView(pending);
  }

  private async referenceOf(tx: TxContext, pending: WagerTransaction): Promise<ReferenceContext> {
    const externalId = pending.referenceExternalTransactionId;

    if (externalId === undefined) {
      return { state: 'NOT_PROVIDED' };
    }
    const reference = await tx.transactions.findByExternalId(pending.providerId, externalId);

    if (!reference) {
      return { state: 'MISSING' };
    }

    return {
      state: 'FOUND',
      transaction: reference,
      ...(await tx.transactions.referenceFacts(reference)),
    };
  }

  private observedBalance(wallet: Wallet | null, decision: WagerDecision): Money | null {
    if (!wallet) {
      return null;
    }
    if (decision.type === 'REJECT' && decision.code === FailureCode.PlayerWalletMismatch) {
      return null;
    }

    return wallet.balance;
  }

  private move(
    wallet: Wallet,
    pending: WagerTransaction,
    direction: LedgerDirection,
    at: Date,
  ): WalletLedgerEntry {
    const movement = {
      money: pending.money,
      transactionId: pending.id,
      entryId: this.ids.next(),
      at,
    };

    return direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  }

  private eventsFor(
    tx: WagerTransaction,
    entry: WalletLedgerEntry | null,
    ctx: ProcessContext,
  ): OutboxMessage[] {
    const eventCtx = {
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
    };

    if (tx.status === WagerStatus.Processed) {
      return this.events.forProcessed(tx, entry, eventCtx);
    }
    if (tx.status === WagerStatus.Rejected) {
      return this.events.forRejected(tx, eventCtx);
    }
    if (tx.status === WagerStatus.Failed) {
      return this.events.forFailed(tx, eventCtx);
    }

    return this.events.forPending(tx, eventCtx);
  }
}
