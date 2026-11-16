import { createSqsClient } from '../src/modules/messaging/infrastructure/sqs-client';
import { ensureQueues } from '../src/modules/messaging/infrastructure/sqs-topology';

const client = createSqsClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  connectTimeoutMs: 5000,
  requestTimeoutMs: 10000,
});
const { wagerUrl, dlqUrl, eventsUrl } = await ensureQueues(client);

for (const url of [wagerUrl, dlqUrl, eventsUrl]) {
  console.log(url);
}
