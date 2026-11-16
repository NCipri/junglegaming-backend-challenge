import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { startPostgres, startSqs, type TestPostgres, type TestSqs } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { uuid } from '../../support/builders';
import { assertAllWalletsInvariants } from '../../support/invariants';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import { createTestQueues, purge, testSqsClient } from '../../support/sqs';
import { createUseCases, RecordingLogger, type UseCases } from '../../support/use-cases';
import { waitUntil } from '../../support/wait-until';
import {
  FaultInjectedError,
  NoopFaultInjector,
  type FaultInjector,
  type FaultPoint,
} from '../../../src/infrastructure/fault/fault-injector';
import { redriveDlq } from '../../../src/modules/messaging/infrastructure/dlq-redrive';
import { createSqsClient } from '../../../src/modules/messaging/infrastructure/sqs-client';
import { SqsConsumer } from '../../../src/modules/messaging/infrastructure/sqs-consumer';
import type { QueueUrls } from '../../../src/modules/messaging/infrastructure/sqs-topology';
import { WagerMessageHandler } from '../../../src/modules/wagering/interface/wager-message.handler';
import { UuidV7Generator } from '../../../src/shared/ids/id-generator';

let pg: TestPostgres;
let sqs: TestSqs;
let db: Client;
let t: TestOrm;
let app: UseCases;
let queues: QueueUrls;
let exhaust: QueueUrls;
let client: SQSClient;

beforeAll(async () => {
  [pg, sqs] = await Promise.all([startPostgres(), startSqs()]);
  await migrateUp(pg.migratorUrl);
  queues = await createTestQueues(sqs.endpoint);
  exhaust = await createTestQueues(sqs.endpoint, { prefix: 'exhaust-', maxReceiveCount: 3 });
  db = new Client({ connectionString: pg.migratorUrl });
  await db.connect();
  t = await createTestOrm(pg.appUrl);
  app = createUseCases(t);
  client = testSqsClient(sqs.endpoint);
}, 180_000);

afterAll(async () => {
  client.destroy();
  await t.close();
  await db.end();
  await Promise.all([pg.stop(), sqs.stop()]);
});

beforeEach(async () => {
  await resetDatabase(pg.migratorUrl);
  await Promise.all(
    [queues.wagerUrl, queues.dlqUrl, exhaust.wagerUrl, exhaust.dlqUrl].map((url) =>
      purge(client, url),
    ),
  );
});

class CountingFaults implements FaultInjector {
  readonly hits: number[] = [];

  constructor(
    private readonly point: FaultPoint,
    private failures: number,
  ) {}

  hit(point: FaultPoint): Promise<void> {
    if (point !== this.point) {
      return Promise.resolve();
    }
    this.hits.push(Date.now());
    if (this.failures > 0) {
      this.failures -= 1;

      return Promise.reject(new Error('simulated transient infrastructure failure'));
    }

    return Promise.resolve();
  }
}

function consumer(
  opts: {
    faults?: FaultInjector;
    urls?: QueueUrls;
    retryBaseSeconds?: number;
    visibilityTimeoutSeconds?: number;
    heartbeatSeconds?: number;
  } = {},
) {
  const faults = opts.faults ?? new NoopFaultInjector();
  const urls = opts.urls ?? queues;

  return new SqsConsumer(
    client,
    new WagerMessageHandler(),
    createUseCases(t, { faults }).processWager,
    t.metrics,
    new RecordingLogger(),
    new UuidV7Generator(),
    faults,
    {
      queueUrl: urls.wagerUrl,
      dlqUrl: urls.dlqUrl,
      consumerName: 'wager-transactions',
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds ?? 30,
      heartbeatSeconds: opts.heartbeatSeconds ?? 10,
      retryBaseSeconds: opts.retryBaseSeconds ?? 1,
      retryCapSeconds: 300,
      maxMessages: 10,
    },
  );
}

async function openWallet(amount = '100.00') {
  const result = await app.openWallet.execute({
    playerId: uuid(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });

  if (result.type !== 'CREATED') {
    throw new Error('expected CREATED');
  }

  return result.wallet;
}

function message(
  wallet: { id: string; playerId: string },
  data: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
) {
  const externalTransactionId = `ext-${uuid()}`;

  return {
    messageId: `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
    ...envelope,
  };
}

async function send(body: unknown, urls: QueueUrls = queues, groupId = 'group-1'): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: urls.wagerUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: uuid(),
    }),
  );
}

async function depth(url: string): Promise<number> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );

  return (
    Number.parseInt(Attributes?.ApproximateNumberOfMessages ?? '0', 10) +
    Number.parseInt(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10)
  );
}

async function count(table: string, where = 'TRUE'): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
  );

  return rows[0]?.n ?? 0;
}

async function balance(walletId: string): Promise<string> {
  return (await app.getWallet.execute(walletId))?.balance.amount ?? 'missing';
}

describe('SqsConsumer — happy path and dedupe', () => {
  test('a valid message is processed, recorded in the inbox and deleted', async () => {
    const wallet = await openWallet();

    await send(message(wallet));

    expect(await consumer().pollOnce()).toBe(1);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(
      await count(
        'inbox_messages',
        "consumer_name = 'wager-transactions' AND processed_at IS NOT NULL",
      ),
    ).toBe(1);
    expect(await depth(queues.wagerUrl)).toBe(0);
    await assertAllWalletsInvariants(db);
  });

  test('the same message delivered twice has one effect and counts one inbox duplicate', async () => {
    const wallet = await openWallet();
    const msg = message(wallet);
    const before = t.metrics.counter('inbox_duplicates_total');

    await send(msg);
    await send(msg);
    const c = consumer();

    await c.pollOnce();
    await c.pollOnce();

    expect(await balance(wallet.id)).toBe('75.00');
    expect(t.metrics.counter('inbox_duplicates_total') - before).toBe(1);
    expect(await depth(queues.wagerUrl)).toBe(0);
    expect(await depth(queues.dlqUrl)).toBe(0);
  });

  test('a legitimate producer resend that only changes occurredAt is a duplicate, not a conflict', async () => {
    const wallet = await openWallet();
    const msg = message(wallet);
    const c = consumer();

    await send(msg);
    await c.pollOnce();
    await send({ ...msg, occurredAt: new Date(Date.now() + 60_000).toISOString() });
    await c.pollOnce();

    expect(await depth(queues.dlqUrl)).toBe(0);
    expect(await balance(wallet.id)).toBe('75.00');
  });

  test('the same messageId with a different body goes to the DLQ and counts a payload conflict', async () => {
    const wallet = await openWallet();
    const msg = message(wallet);
    const before = t.metrics.counter('inbox_payload_conflict_total');
    const c = consumer();

    await send(msg);
    await c.pollOnce();
    await send({ ...msg, data: { ...msg.data, money: { amount: '30.00', currency: 'BRL' } } });
    await c.pollOnce();

    expect(t.metrics.counter('inbox_payload_conflict_total') - before).toBe(1);
    expect(await depth(queues.dlqUrl)).toBe(1);
    expect(await balance(wallet.id)).toBe('75.00');
  });

  test('a business rejection is recorded and acknowledged, never sent to the DLQ', async () => {
    const wallet = await openWallet('10.00');

    await send(message(wallet));
    await consumer().pollOnce();

    expect(await count('wager_transactions', "status = 'REJECTED'")).toBe(1);
    expect(await depth(queues.wagerUrl)).toBe(0);
    expect(await depth(queues.dlqUrl)).toBe(0);
  });
});

describe('SqsConsumer — permanent errors go straight to the DLQ, nothing recorded', () => {
  test.each([
    ['invalid JSON', () => '{"messageId":'],
    [
      'an unknown type',
      (w: { id: string; playerId: string }) => message(w, {}, { type: 'SomethingElse' }),
    ],
    [
      'data without walletId',
      (w: { id: string; playerId: string }) => {
        const m = message(w);
        const data: Record<string, unknown> = { ...m.data };

        delete data['walletId'];

        return { ...m, data };
      },
    ],
    ['data with an extra field', (w: { id: string; playerId: string }) => message(w, { extra: 1 })],
    [
      'a zero BET',
      (w: { id: string; playerId: string }) =>
        message(w, { money: { amount: '0.00', currency: 'BRL' } }),
    ],
    [
      'an envelope extra field',
      (w: { id: string; playerId: string }) => message(w, {}, { extra: true }),
    ],
  ])('%s', async (_, build) => {
    const wallet = await openWallet();
    const before = await count('wager_transactions');

    await send(build(wallet));
    await consumer().pollOnce();

    expect(await depth(queues.dlqUrl)).toBe(1);
    expect(await depth(queues.wagerUrl)).toBe(0);
    expect(await count('wager_transactions')).toBe(before);
    expect(await count('inbox_messages')).toBe(0);
  });

  test('the same key with a different payload (IDEMPOTENCY_CONFLICT) goes to the DLQ', async () => {
    const wallet = await openWallet();
    const first = message(wallet);
    const c = consumer();

    await send(first);
    await c.pollOnce();
    await send(message(wallet, { ...first.data, money: { amount: '26.00', currency: 'BRL' } }));
    await c.pollOnce();

    expect(await depth(queues.dlqUrl)).toBe(1);
    expect(await balance(wallet.id)).toBe('75.00');
  });

  test('a deterministic error records FAILED with its event and sends the message to the DLQ', async () => {
    const wallet = await openWallet('99999999999999999.00');

    await send(message(wallet, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } }));
    await consumer().pollOnce();

    expect(await count('wager_transactions', "status = 'FAILED'")).toBe(1);
    expect(await count('outbox_messages', "event_type = 'WagerTransactionFailed'")).toBe(1);
    expect(await depth(queues.dlqUrl)).toBe(1);
  });
});

describe('SqsConsumer — transient errors, exhaustion and redrive', () => {
  test('a transient error leaves the message for redelivery with backoff, then it is processed, never FAILED', async () => {
    const wallet = await openWallet();
    const faults = new CountingFaults('before-commit', 6);
    const c = consumer({ faults, retryBaseSeconds: 1 });

    await send(message(wallet));
    await waitUntil(async () => (await c.pollOnce()) > 0 && faults.hits.length >= 7, {
      timeoutMs: 20_000,
      intervalMs: 10,
    });

    expect(faults.hits).toHaveLength(7);
    const at = (i: number) => faults.hits[i] ?? 0;

    expect(at(3) - at(2)).toBeGreaterThanOrEqual(900);
    expect(at(6) - at(5)).toBeGreaterThanOrEqual(1900);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await count('wager_transactions', "status = 'FAILED'")).toBe(0);
    expect(await depth(queues.dlqUrl)).toBe(0);
  }, 30_000);

  test('after maxReceiveCount transient failures the message reaches the DLQ without FAILED; the redrive brings it back once', async () => {
    const wallet = await openWallet();
    const faults = new CountingFaults('before-commit', Number.MAX_SAFE_INTEGER);
    const failing = consumer({ faults, urls: exhaust, retryBaseSeconds: 1 });

    await send(message(wallet), exhaust);
    await waitUntil(
      async () => {
        await failing.pollOnce();

        return (await depth(exhaust.dlqUrl)) === 1;
      },
      { timeoutMs: 30_000, intervalMs: 10 },
    );

    expect(faults.hits).toHaveLength(9);
    expect(await count('wager_transactions')).toBe(1);
    expect(await count('wager_transactions', "status = 'FAILED'")).toBe(0);
    expect(await redriveDlq(client, exhaust.dlqUrl, exhaust.wagerUrl, new UuidV7Generator())).toBe(
      1,
    );
    expect(await depth(exhaust.dlqUrl)).toBe(0);
    await waitUntil(async () => (await consumer({ urls: exhaust }).pollOnce()) > 0, {
      timeoutMs: 10_000,
    });

    expect(await balance(wallet.id)).toBe('75.00');
    expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(1);
  }, 30_000);
});

describe('SqsConsumer — long polling', () => {
  test('a long poll on an empty queue outlives the client request timeout without failing', async () => {
    const shortTimeoutClient = createSqsClient({
      endpoint: sqs.endpoint,
      region: 'us-east-1',
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
    });
    const longPolling = new SqsConsumer(
      shortTimeoutClient,
      new WagerMessageHandler(),
      app.processWager,
      t.metrics,
      new RecordingLogger(),
      new UuidV7Generator(),
      new NoopFaultInjector(),
      {
        queueUrl: queues.wagerUrl,
        dlqUrl: queues.dlqUrl,
        consumerName: 'wager-transactions',
        waitTimeSeconds: 3,
        visibilityTimeoutSeconds: 30,
        heartbeatSeconds: 10,
        retryBaseSeconds: 1,
        retryCapSeconds: 300,
        maxMessages: 10,
      },
    );
    const startedAt = Date.now();

    try {
      expect(await longPolling.pollOnce()).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2500);
    } finally {
      shortTimeoutClient.destroy();
    }
  }, 30_000);
});

describe('SqsConsumer — visibility of the whole batch', () => {
  test('messages waiting behind a slow one in the same batch stay invisible to other consumers', async () => {
    const wallet = await openWallet();
    const holder = new Client({ connectionString: pg.migratorUrl });

    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
    await send(message(wallet), queues, wallet.id);
    await send(message(wallet), queues, wallet.id);
    const slow = consumer({ visibilityTimeoutSeconds: 2, heartbeatSeconds: 1 });
    const running = slow.pollOnce();
    let stolen = 0;

    try {
      const peeker = consumer({ visibilityTimeoutSeconds: 2, heartbeatSeconds: 1 });
      const deadline = Date.now() + 3500;

      while (Date.now() < deadline) {
        stolen += await peeker.pollOnce();
      }
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    const processedBySlow = await running;

    expect(stolen).toBe(0);
    expect(processedBySlow).toBe(2);
    expect(await balance(wallet.id)).toBe('50.00');
    expect(await depth(queues.wagerUrl)).toBe(0);
  }, 30_000);
});

describe('SqsConsumer — graceful shutdown', () => {
  test('stop cancels a message stuck on a wallet lock, rolls it back, then returns it; another consumer processes it once', async () => {
    const wallet = await openWallet();
    const holder = new Client({ connectionString: pg.migratorUrl });

    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
    await send(message(wallet));
    const stuck = consumer();

    stuck.start();
    await waitUntil(() => Promise.resolve(stuck.inFlight() === 1), { timeoutMs: 10_000 });
    const stoppedAt = Date.now();

    await stuck.stop({ graceMs: 2000 });
    await holder.query('ROLLBACK');
    await holder.end();

    expect(Date.now() - stoppedAt).toBeLessThan(4000);
    expect(await count('inbox_messages')).toBe(0);
    const started = Date.now();

    await waitUntil(async () => (await consumer().pollOnce()) > 0, {
      timeoutMs: 5000,
      intervalMs: 10,
    });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(1);
  }, 30_000);

  test('a crash after commit and before ack is redelivered and deduplicated by the inbox', async () => {
    const wallet = await openWallet();
    const crash: FaultInjector = {
      hit: (point) =>
        point === 'after-commit-before-ack'
          ? Promise.reject(new FaultInjectedError(point))
          : Promise.resolve(),
    };

    await send(message(wallet));
    let crashed = false;

    try {
      await consumer({ faults: crash, visibilityTimeoutSeconds: 2 }).pollOnce();
    } catch {
      crashed = true;
    }

    expect(crashed).toBe(true);
    expect(await balance(wallet.id)).toBe('75.00');
    await waitUntil(async () => (await consumer().pollOnce()) > 0, {
      timeoutMs: 15_000,
      intervalMs: 50,
    });

    expect(t.metrics.counter('inbox_duplicates_total')).toBeGreaterThanOrEqual(1);

    expect(await balance(wallet.id)).toBe('75.00');
    expect(await depth(queues.wagerUrl)).toBe(0);
  }, 30_000);
});
