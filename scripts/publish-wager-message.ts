import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../src/modules/messaging/infrastructure/sqs-client';
import { UuidV7Generator } from '../src/shared/ids/id-generator';

const raw = process.argv[2];

if (!raw) {
  console.error(
    "Usage: bun run publish:wager '<data JSON with providerId, externalTransactionId, ...>'",
  );
  process.exit(1);
}
const data = JSON.parse(raw) as { walletId?: string };
const ids = new UuidV7Generator();
const messageId = ids.next();
const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const queueUrl =
  process.env.SQS_WAGER_QUEUE_URL ?? `${endpoint}/000000000000/wager-transactions.fifo`;
const client = createSqsClient({
  endpoint,
  region: process.env.SQS_REGION ?? 'us-east-1',
  connectTimeoutMs: 5000,
  requestTimeoutMs: 10000,
});

await client.send(
  new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data,
    }),
    MessageGroupId: data.walletId ?? messageId,
    MessageDeduplicationId: messageId,
  }),
);
console.log(`Published ${messageId} to ${queueUrl}`);
client.destroy();
