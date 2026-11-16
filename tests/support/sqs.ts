import type { SQSClient } from '@aws-sdk/client-sqs';
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

export async function createTestQueues(endpoint: string): Promise<QueueUrls> {
  const client = testSqsClient(endpoint);

  try {
    return await ensureQueues(client);
  } finally {
    client.destroy();
  }
}
