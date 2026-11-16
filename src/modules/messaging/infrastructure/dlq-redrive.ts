// DLQ redrive: receive → send to the source queue with a new deduplication id and the same group → delete.
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { IdGenerator } from '../../../shared/ids/id-generator';

export async function redriveDlq(
  client: SQSClient,
  dlqUrl: string,
  targetUrl: string,
  ids: IdGenerator,
): Promise<number> {
  let moved = 0;

  for (;;) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );

    if (Messages.length === 0) {
      return moved;
    }
    for (const message of Messages) {
      const attributes = Object.fromEntries(
        Object.entries(message.MessageAttributes ?? {}).filter(([name]) => name !== 'reason'),
      );

      await client.send(
        new SendMessageCommand({
          QueueUrl: targetUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.['MessageGroupId'] ?? 'redrive',
          MessageDeduplicationId: ids.next(),
          MessageAttributes: attributes,
        }),
      );
      await client.send(
        new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle }),
      );
      moved += 1;
    }
  }
}
