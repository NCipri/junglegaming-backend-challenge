import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const MAX_RECEIVE_COUNT = 8;

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

async function createQueue(name: string): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: name, Attributes: fifo }),
  );

  if (!QueueUrl) {
    throw new Error(`Queue ${name} has no URL`);
  }

  return QueueUrl;
}

async function queueArn(queueUrl: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = Attributes?.QueueArn;

  if (!arn) {
    throw new Error(`Queue ${queueUrl} has no ARN`);
  }

  return arn;
}

const dlqUrl = await createQueue('wager-transactions-dlq.fifo');
const wagerUrl = await createQueue('wager-transactions.fifo');

await client.send(
  new SetQueueAttributesCommand({
    QueueUrl: wagerUrl,
    Attributes: {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: await queueArn(dlqUrl),
        maxReceiveCount: String(MAX_RECEIVE_COUNT),
      }),
    },
  }),
);
const eventsUrl = await createQueue('wallet-events.fifo');

for (const url of [wagerUrl, dlqUrl, eventsUrl]) {
  console.log(url);
}
