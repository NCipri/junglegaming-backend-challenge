// Publishes an outbox row to the events FIFO queue: group = partition key, dedup id = event id, body sent as stored.
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { ClaimedOutboxMessage } from './outbox.repository.types';

export interface EventPublisher {
  publish(message: ClaimedOutboxMessage): Promise<void>;
}

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: ClaimedOutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: message.payloadText,
        MessageGroupId: message.partitionKey,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
          eventVersion: { DataType: 'Number', StringValue: String(message.eventVersion) },
        },
      }),
    );
  }
}
