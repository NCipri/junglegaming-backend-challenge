import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/modules/messaging/infrastructure/sqs-client';
import {
  ensureQueues,
  type QueueUrls,
} from '../../src/modules/messaging/infrastructure/sqs-topology';

export function testSqsClient(endpoint: string): SQSClient {
  return createSqsClient({
    endpoint,
    region: 'us-east-1',
    connectTimeoutMs: 5000,
    requestTimeoutMs: 25000,
  });
}

export async function createTestQueues(
  endpoint: string,
  opts: { prefix?: string; maxReceiveCount?: number } = {},
): Promise<QueueUrls> {
  const client = testSqsClient(endpoint);

  try {
    return await ensureQueues(client, opts);
  } finally {
    client.destroy();
  }
}

export interface ReceivedMessage {
  messageId: string;
  body: string;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  attributes: Record<string, string | undefined>;
}

export async function receiveAll(
  client: SQSClient,
  queueUrl: string,
  opts: { waitMs: number; expected?: number },
): Promise<ReceivedMessage[]> {
  const received: ReceivedMessage[] = [];
  const deadline = Date.now() + opts.waitMs;

  while (Date.now() < deadline) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );

    for (const message of Messages) {
      received.push({
        messageId: message.MessageId ?? '',
        body: message.Body ?? '',
        groupId: message.Attributes?.['MessageGroupId'],
        deduplicationId: message.Attributes?.['MessageDeduplicationId'],
        attributes: Object.fromEntries(
          Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [
            key,
            value.StringValue,
          ]),
        ),
      });
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
    if (opts.expected !== undefined && received.length >= opts.expected) {
      break;
    }
  }

  return received;
}

export async function purge(client: SQSClient, queueUrl: string): Promise<void> {
  await receiveAll(client, queueUrl, { waitMs: 1500 });
}
