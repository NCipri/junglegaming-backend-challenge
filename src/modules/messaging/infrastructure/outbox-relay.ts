// Outbox relay: claims due events with a lease, publishes them outside any transaction, then marks or reschedules them.
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import type { FaultInjector } from '../../../infrastructure/fault/fault-injector';
import { computeBackoff } from '../../../shared/time/backoff';
import type { Clock } from '../../../shared/time/clock';
import type { AppLogger } from '../../observability/logger.port';
import type { MetricsPort } from '../../observability/metrics.port';
import type { OutboxRelaySettings } from './outbox-relay.types';
import type { ClaimedOutboxMessage } from './outbox.repository.types';
import type { EventPublisher } from './sqs-event-publisher';

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class OutboxRelay {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly runner: WalletTransactionRunner,
    private readonly publisher: EventPublisher,
    private readonly metrics: MetricsPort,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
    private readonly logger: AppLogger,
    private readonly settings: OutboxRelaySettings,
  ) {}

  async tick(): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.runner.read((tx) =>
      tx.outbox.claimDue({
        instanceId: this.settings.instanceId,
        limit: this.settings.batchSize,
        leaseMs: this.settings.leaseMs,
        now,
      }),
    );

    if (claimed.length > 0) {
      await this.faults.hit('after-claim-before-publish');
    }
    const groups = new Map<string, ClaimedOutboxMessage[]>();

    for (const message of claimed) {
      groups.set(message.partitionKey, [...(groups.get(message.partitionKey) ?? []), message]);
    }
    const published = await Promise.all(
      [...groups.values()].map((group) => this.publishGroup(group, now)),
    );
    const lag = await this.runner.read((tx) => tx.outbox.oldestPendingAgeSeconds(this.clock.now()));

    this.metrics.set('outbox_lag_seconds', lag);

    return published.reduce((total, count) => total + count, 0);
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;

      try {
        published = await this.tick();
      } catch (error) {
        this.logger.error(
          { instanceId: this.settings.instanceId, error: errorText(error) },
          'Outbox relay tick failed',
        );
      }
      if (this.running && published < this.settings.batchSize) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.settings.pollMs);

          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }

  private async publishGroup(group: ClaimedOutboxMessage[], now: Date): Promise<number> {
    let published = 0;

    for (const [index, message] of group.entries()) {
      const startedAt = performance.now();

      try {
        await this.publisher.publish(message);
      } catch (error) {
        await this.reschedule(message, group.slice(index + 1), now, error);

        return published;
      }
      this.metrics.observe(
        'outbox_publish_duration_seconds',
        (performance.now() - startedAt) / 1000,
      );
      await this.faults.hit('after-publish-before-mark');
      await this.runner.read((tx) => tx.outbox.markPublished(message.id, this.clock.now()));
      published += 1;
    }

    return published;
  }

  private async reschedule(
    failed: ClaimedOutboxMessage,
    followers: ClaimedOutboxMessage[],
    now: Date,
    error: unknown,
  ): Promise<void> {
    const delayMs = computeBackoff({
      attempts: failed.attempts,
      baseMs: this.settings.retryBaseMs,
      capMs: this.settings.retryCapMs,
      random: this.settings.random ?? Math.random,
    });
    const nextAttemptAt = new Date(now.getTime() + delayMs);

    this.metrics.increment('outbox_publish_retries_total');
    this.logger.warn(
      {
        eventId: failed.id,
        eventType: failed.eventType,
        attempts: failed.attempts + 1,
        error: errorText(error),
      },
      'Outbox publish failed; rescheduled',
    );
    await this.runner.read(async (tx) => {
      await tx.outbox.scheduleRetry(
        failed.id,
        nextAttemptAt,
        failed.attempts + 1,
        errorText(error),
      );
      await tx.outbox.deferUnpublished(
        followers.map((message) => message.id),
        nextAttemptAt,
      );
    });
  }
}
