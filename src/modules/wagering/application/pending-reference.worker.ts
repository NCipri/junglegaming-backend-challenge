// Pending-reference worker: claims due rows with a lease in a short transaction, then resolves each in its own transaction.
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import type { Clock } from '../../../shared/time/clock';
import type { AppLogger } from '../../observability/logger.port';
import type { PendingWorkerSettings } from './pending-reference.worker.types';
import type { ResolvePendingReference } from './resolve-pending-reference';

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class PendingReferenceWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly runner: WalletTransactionRunner,
    private readonly resolve: ResolvePendingReference,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly settings: PendingWorkerSettings,
  ) {}

  async tick(): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.runner.read((tx) =>
      tx.transactions.claimDuePending({
        instanceId: this.settings.instanceId,
        limit: this.settings.batchSize,
        leaseMs: this.settings.leaseMs,
        now,
      }),
    );
    const queue = [...claimed];
    const lane = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          await this.resolve.execute(id, this.clock.now());
        } catch (error) {
          this.logger.error(
            { transactionId: id, error: errorText(error) },
            'Pending reference resolution failed',
          );
        }
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, this.settings.concurrency) }, lane));

    return claimed.length;
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
      let claimed = 0;

      try {
        claimed = await this.tick();
      } catch (error) {
        this.logger.error(
          { instanceId: this.settings.instanceId, error: errorText(error) },
          'Pending worker tick failed',
        );
      }
      if (this.running && claimed < this.settings.batchSize) {
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
}
