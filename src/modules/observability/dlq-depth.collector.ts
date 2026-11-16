// Periodically reads the DLQ depth into the dlq_depth gauge, including messages moved there by SQS itself.
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { AppLogger } from './logger.port';
import type { MetricsPort } from './metrics.port';

export class DlqDepthCollector {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: SQSClient,
    private readonly dlqUrl: string,
    private readonly metrics: MetricsPort,
    private readonly logger: AppLogger,
    private readonly settings: { intervalMs: number; timeoutMs: number },
  ) {}

  async collect(): Promise<void> {
    try {
      const { Attributes } = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.dlqUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
        { abortSignal: AbortSignal.timeout(this.settings.timeoutMs) },
      );

      this.metrics.set(
        'dlq_depth',
        Number.parseInt(Attributes?.ApproximateNumberOfMessages ?? '0', 10) || 0,
      );
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'DLQ depth read failed',
      );
    }
  }

  start(): void {
    void this.collect();
    this.timer = setInterval(() => void this.collect(), this.settings.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
  }
}
