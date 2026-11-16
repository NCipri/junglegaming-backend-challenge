import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { uuid } from '../../support/builders';
import { startTestApi, type TestApi } from '../../support/http';
import { captureLogs, type LogCapture } from '../../support/log-capture';
import { testSqsClient } from '../../support/sqs';
import { waitUntil } from '../../support/wait-until';

let api: TestApi;
let capture: LogCapture;

beforeAll(async () => {
  capture = captureLogs();
  api = await startTestApi({ logger: capture.logger }, { roles: 'api,sqs-consumer' });
}, 180_000);

afterAll(async () => {
  await api.stop();
});

describe('structured, redacted logs', () => {
  test('a BET over HTTP and another over SQS log JSON with ids and never the amount, balance, player or token', async () => {
    const playerId = uuid();
    const created = await api.request('POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
    });
    const walletId = String(created.json['id']);
    const token = await api.providerToken('provider-a');
    const data = (externalTransactionId: string) => ({
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    const http = await api.request('POST', '/wagering/transactions', {
      token,
      body: data('http-1'),
      headers: { 'idempotency-key': 'provider-a:http-1' },
    });
    const sqs = testSqsClient(api.sqs.endpoint);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: api.config.sqs.wagerQueueUrl,
        MessageBody: JSON.stringify({
          messageId: 'msg-log-1',
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...data('sqs-1'), idempotencyKey: 'provider-a:sqs-1' },
        }),
        MessageGroupId: walletId,
        MessageDeduplicationId: uuid(),
      }),
    );
    sqs.destroy();
    await waitUntil(
      () => Promise.resolve(capture.entries().some((entry) => entry['messageId'] === 'msg-log-1')),
      { timeoutMs: 15_000 },
    );
    const entries = capture.entries();
    const text = capture.lines().join('\n');
    const processed = entries.filter((entry) => entry['msg'] === 'Wager transaction processed');

    expect(http.status).toBe(200);
    expect(processed).toHaveLength(2);
    for (const entry of processed) {
      expect(entry).toMatchObject({
        correlationId: expect.any(String) as string,
        transactionId: expect.any(String) as string,
        walletId,
        providerId: 'provider-a',
        kind: 'BET',
        status: 'PROCESSED',
      });
    }
    expect(processed.map((entry) => entry['channel']).sort()).toEqual(['HTTP', 'SQS']);
    expect(
      entries.some((entry) => entry['msg'] === 'HTTP request' && entry['statusCode'] === 200),
    ).toBe(true);
    expect(text).not.toContain('25.00');
    expect(text).not.toContain('975.00');
    expect(text).not.toContain('1000.00');
    expect(text).not.toContain(playerId);
    expect(text).not.toContain(token);
  }, 30_000);

  test('sensitive fields are redacted even when logged by mistake', () => {
    capture.logger.info(
      {
        playerId: 'p-1',
        money: { amount: '1.00', currency: 'BRL' },
        balance: { amount: '2.00' },
        nested: { amount: '3.00', playerId: 'p-2', storedBalance: { amount: '4.00' } },
        authorization: 'Bearer secret-token',
      },
      'oops',
    );
    const line = capture.lines().at(-1) ?? '';

    for (const secret of ['p-1', 'p-2', '1.00', '2.00', '3.00', '4.00', 'secret-token']) {
      expect(line).not.toContain(secret);
    }
    expect(JSON.parse(line)).toMatchObject({ msg: 'oops', instanceId: 'test-instance' });
  });
});
