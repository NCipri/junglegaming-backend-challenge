// Resolves one pending transaction under its wallet lock: first try to resolve, then expire by TTL, else reschedule.
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import { computeBackoff } from '../../../shared/time/backoff';
import type { Clock } from '../../../shared/time/clock';
import { WagerStatus } from '../domain/wager-status';
import type { ResolveOutcome, ResolvePendingSettings } from './resolve-pending-reference.types';
import type { WagerProcessor } from './wager-processor';

export class ResolvePendingReference {
  constructor(
    private readonly runner: WalletTransactionRunner,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly settings: ResolvePendingSettings,
  ) {}

  execute(transactionId: string, now: Date = this.clock.now()): Promise<ResolveOutcome> {
    return this.runner.run(async (tx) => {
      const snapshot = await tx.transactions.findById(transactionId);

      if (snapshot?.status !== WagerStatus.PendingReference) {
        return 'SKIPPED';
      }
      const wallet = await tx.wallets.lockById(snapshot.walletId);
      const pending = await tx.transactions.findById(transactionId);

      if (pending?.status !== WagerStatus.PendingReference) {
        return 'SKIPPED';
      }
      const ctx = { wallet, correlationId: pending.correlationId };
      const view = await this.processor.processLocked(tx, pending, ctx);

      if (view.status === WagerStatus.Processed) {
        return 'PROCESSED';
      }
      if (view.status === WagerStatus.Rejected) {
        return 'REJECTED';
      }
      const expiresAt = pending.expiresAt;

      if (expiresAt && now.getTime() >= expiresAt.getTime()) {
        await this.processor.rejectExpired(tx, pending, ctx, now);

        return 'REJECTED';
      }
      const delayMs = computeBackoff({
        attempts: pending.attempts,
        baseMs: this.settings.retryBaseMs,
        capMs: this.settings.retryCapMs,
        random: this.settings.random ?? Math.random,
      });

      pending.scheduleRetry(new Date(now.getTime() + delayMs));
      await tx.transactions.update(pending);

      return 'STILL_PENDING';
    });
  }
}
