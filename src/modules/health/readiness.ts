// Readiness: PostgreSQL and SQS reachable within the health timeout, and the instance not shutting down.
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { ReadinessReport, ReadinessSettings } from './readiness.types';

export class ShutdownState {
  private draining = false;

  begin(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }
}

async function probe(
  work: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
): Promise<'up' | 'down'> {
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    await Promise.race([
      work(signal),
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('health probe timeout')));
      }),
    ]);

    return 'up';
  } catch {
    return 'down';
  }
}

export class ReadinessProbe {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly state: ShutdownState,
    private readonly settings: ReadinessSettings,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, queue] = await Promise.all([
      probe(() => this.orm.em.fork().execute('SELECT 1'), this.settings.timeoutMs),
      probe(
        (abortSignal) =>
          this.sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: this.settings.queueUrl,
              AttributeNames: ['QueueArn'],
            }),
            { abortSignal },
          ),
        this.settings.timeoutMs,
      ),
    ]);
    const shuttingDown = this.state.isDraining();

    return {
      ready: database === 'up' && queue === 'up' && !shuttingDown,
      checks: { database, sqs: queue, shuttingDown },
    };
  }
}
