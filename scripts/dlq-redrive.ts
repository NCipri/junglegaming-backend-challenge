import { createSqsClient } from '../src/modules/messaging/infrastructure/sqs-client';
import { redriveDlq } from '../src/modules/messaging/infrastructure/dlq-redrive';
import { UuidV7Generator } from '../src/shared/ids/id-generator';

const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const dlqUrl =
  process.env.SQS_WAGER_DLQ_URL ?? `${endpoint}/000000000000/wager-transactions-dlq.fifo`;
const targetUrl =
  process.env.SQS_WAGER_QUEUE_URL ?? `${endpoint}/000000000000/wager-transactions.fifo`;
const client = createSqsClient({
  endpoint,
  region: process.env.SQS_REGION ?? 'us-east-1',
  connectTimeoutMs: 5000,
  requestTimeoutMs: 10000,
});
const moved = await redriveDlq(client, dlqUrl, targetUrl, new UuidV7Generator());

console.log(`Redrove ${moved} message(s) from ${dlqUrl} to ${targetUrl}`);
client.destroy();
