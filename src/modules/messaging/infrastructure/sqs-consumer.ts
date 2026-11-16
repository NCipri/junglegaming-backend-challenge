// SQS consumer: same use case as HTTP, ack only after commit, transient → visibility backoff, permanent/FAILED → DLQ, graceful stop.
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { classifyError } from '../../../infrastructure/db/error-classification';
import {
  FaultInjectedError,
  type FaultInjector,
} from '../../../infrastructure/fault/fault-injector';
import { DomainError } from '../../../shared/errors/domain-error';
import type { IdGenerator } from '../../../shared/ids/id-generator';
import type { AppLogger } from '../../observability/logger.port';
import type { MetricsPort } from '../../observability/metrics.port';
import type { ProcessWagerTransaction } from '../../wagering/application/process-wager-transaction';
import type { WagerResult } from '../../wagering/application/wager-result';
import { WagerStatus } from '../../wagering/domain/wager-status';
import {
  PermanentMessageError,
  type WagerMessageHandler,
} from '../../wagering/interface/wager-message.handler';
import type { MessageConsumerPort, SqsConsumerSettings } from './sqs-consumer.types';

export type { MessageConsumerPort, SqsConsumerSettings } from './sqs-consumer.types';

type Outcome = 'DONE' | 'RETRY' | 'RELEASED';

const PERMANENT_RESULTS: Partial<Record<WagerResult['type'], string>> = {
  INBOX_PAYLOAD_CONFLICT: 'INBOX_PAYLOAD_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  EXTERNAL_ID_CONFLICT: 'EXTERNAL_TRANSACTION_ID_CONFLICT',
};

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class SqsConsumer implements MessageConsumerPort {
  private running = false;
  private loop: Promise<void> | null = null;
  private pollAbort: AbortController | null = null;
  private readonly inflight = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly client: SQSClient,
    private readonly handler: WagerMessageHandler,
    private readonly processWager: ProcessWagerTransaction,
    private readonly metrics: MetricsPort,
    private readonly logger: AppLogger,
    private readonly ids: IdGenerator,
    private readonly faults: FaultInjector,
    private readonly settings: SqsConsumerSettings,
  ) {}

  inFlight(): number {
    return this.inflight.size;
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.settings.queueUrl,
        MaxNumberOfMessages: this.settings.maxMessages,
        WaitTimeSeconds: this.settings.waitTimeSeconds,
        VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      signal ? { abortSignal: signal } : {},
    );
    const groups = new Map<string, Message[]>();

    for (const message of Messages) {
      const group = message.Attributes?.['MessageGroupId'] ?? message.MessageId ?? '';

      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    const work = Promise.all([...groups.values()].map((group) => this.processGroup(group)));

    this.pending.add(work);
    try {
      await work;
    } finally {
      this.pending.delete(work);
    }

    return Messages.length;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.pollAbort = new AbortController();
    this.loop = this.run(this.pollAbort.signal);
  }

  async stop(opts: { graceMs: number }): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    const drained = Promise.allSettled([...this.pending]);
    const timedOut = await Promise.race([
      drained.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), opts.graceMs)),
    ]);

    if (timedOut) {
      for (const controller of this.inflight.values()) {
        controller.abort(new Error('consumer shutdown'));
      }
      await drained;
    }
    await this.loop;
    this.loop = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce(signal);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        this.logger.error(
          { queue: this.settings.queueUrl, error: errorText(error) },
          'SQS poll failed',
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async processGroup(group: Message[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      const outcome = await this.handle(message);

      if (outcome !== 'DONE') {
        await Promise.all(
          group.slice(index + 1).map((follower) => this.changeVisibility(follower, 0)),
        );

        return;
      }
    }
  }

  private async handle(message: Message): Promise<Outcome> {
    const handle = message.ReceiptHandle ?? '';
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      this.changeVisibility(message, this.settings.visibilityTimeoutSeconds).catch(
        (error: unknown) => {
          this.logger.warn({ error: errorText(error) }, 'Visibility heartbeat failed');
        },
      );
    }, this.settings.heartbeatSeconds * 1000);

    this.inflight.set(handle, controller);
    try {
      return await this.process(message, controller.signal);
    } catch (error) {
      if (error instanceof FaultInjectedError) {
        throw error;
      }
      if (controller.signal.aborted) {
        await this.changeVisibility(message, 0);

        return 'RELEASED';
      }
      if (error instanceof DomainError) {
        await this.toDlq(message, error.code);

        return 'DONE';
      }
      await this.retryLater(message, error);

      return 'RETRY';
    } finally {
      clearInterval(heartbeat);
      this.inflight.delete(handle);
    }
  }

  private async process(message: Message, signal: AbortSignal): Promise<Outcome> {
    let parsed;

    try {
      parsed = this.handler.parse(
        message.Body ?? '',
        message.MessageAttributes?.['correlationId']?.StringValue,
      );
    } catch (error) {
      if (error instanceof PermanentMessageError) {
        await this.toDlq(message, error.reason);

        return 'DONE';
      }
      throw error;
    }
    const result = await this.processWager.execute(
      parsed.command,
      {
        type: 'SQS',
        consumerName: this.settings.consumerName,
        messageId: parsed.messageId,
        messageHash: parsed.messageHash,
      },
      { signal },
    );

    await this.faults.hit('after-commit-before-ack');
    const permanent = PERMANENT_RESULTS[result.type];

    if (permanent) {
      await this.toDlq(message, permanent);
    } else if (
      result.type === 'RESULT' &&
      result.view.status === WagerStatus.Failed &&
      !result.replay
    ) {
      await this.toDlq(message, 'UNEXPECTED_PROCESSING_ERROR');
    } else {
      await this.delete(message);
    }

    return 'DONE';
  }

  private async retryLater(message: Message, error: unknown): Promise<void> {
    const receiveCount =
      Number.parseInt(message.Attributes?.['ApproximateReceiveCount'] ?? '1', 10) || 1;
    const delay = Math.min(
      this.settings.retryBaseSeconds * 2 ** (receiveCount - 1),
      this.settings.retryCapSeconds,
    );
    const reason = classifyError(error).kind === 'TRANSIENT' ? classifyError(error) : null;

    this.metrics.increment('processing_retries_total', {
      reason: reason && 'reason' in reason ? reason.reason : 'UNKNOWN',
    });
    this.logger.warn(
      { messageId: message.MessageId, receiveCount, delaySeconds: delay, error: errorText(error) },
      'Transient failure; message will be redelivered',
    );
    await this.changeVisibility(message, delay);
  }

  private async toDlq(message: Message, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.settings.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.['MessageGroupId'] ?? 'dead-letter',
        MessageDeduplicationId: this.ids.next(),
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
          ...(message.MessageAttributes?.['correlationId']
            ? { correlationId: message.MessageAttributes['correlationId'] }
            : {}),
        },
      }),
    );
    await this.delete(message);
    this.metrics.increment('dlq_messages_total', { reason });
    this.logger.error({ messageId: message.MessageId, reason }, 'Message sent to the DLQ');
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.settings.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.settings.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}
