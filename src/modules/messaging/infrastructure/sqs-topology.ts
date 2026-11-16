// Idempotent creation of the FIFO queues: wager input with its DLQ (maxReceiveCount 8) and wallet events.
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export const MAX_RECEIVE_COUNT = 8;

export interface QueueUrls {
  wagerUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

const FIFO = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

async function createQueue(client: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: name, Attributes: FIFO }),
  );

  if (!QueueUrl) {
    throw new Error(`Queue ${name} has no URL`);
  }

  return QueueUrl;
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = Attributes?.QueueArn;

  if (!arn) {
    throw new Error(`Queue ${queueUrl} has no ARN`);
  }

  return arn;
}

export async function ensureQueues(client: SQSClient): Promise<QueueUrls> {
  const dlqUrl = await createQueue(client, 'wager-transactions-dlq.fifo');
  const wagerUrl = await createQueue(client, 'wager-transactions.fifo');

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: wagerUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: await queueArn(client, dlqUrl),
          maxReceiveCount: String(MAX_RECEIVE_COUNT),
        }),
      },
    }),
  );
  const eventsUrl = await createQueue(client, 'wallet-events.fifo');

  return { wagerUrl, dlqUrl, eventsUrl };
}
