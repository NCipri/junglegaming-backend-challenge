// SQS client factory with explicit connection and request timeouts.
import { SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { SqsClientOptions } from './sqs-client.types';

export function createSqsClient(options: SqsClientOptions): SQSClient {
  return new SQSClient({
    endpoint: options.endpoint,
    region: options.region,
    credentials: options.credentials ?? { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: options.connectTimeoutMs,
      requestTimeout: options.requestTimeoutMs,
      throwOnRequestTimeout: true,
    }),
  });
}
