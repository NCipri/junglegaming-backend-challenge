import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { startPostgres, startSqs, type TestPostgres, type TestSqs } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { uuid } from '../../support/builders';
import { FakeClock } from '../../support/clock';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import { createTestQueues, purge, receiveAll, testSqsClient } from '../../support/sqs';
import {
  BlockingFaultInjector,
  createUseCases,
  ThrowingFaultInjector,
  wagerCommand,
  type UseCases,
} from '../../support/use-cases';
import { waitUntil } from '../../support/wait-until';
import {
  NoopFaultInjector,
  type FaultInjector,
} from '../../../src/infrastructure/fault/fault-injector';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { createSqsClient } from '../../../src/modules/messaging/infrastructure/sqs-client';
import type { QueueUrls } from '../../../src/modules/messaging/infrastructure/sqs-topology';
import { OutboxRelay } from '../../../src/modules/messaging/infrastructure/outbox-relay';
import { SqsEventPublisher } from '../../../src/modules/messaging/infrastructure/sqs-event-publisher';
import { NoopLogger } from '../../../src/modules/observability/logger.port';

let pg: TestPostgres;
let sqs: TestSqs;
let db: Client;
let t: TestOrm;
let app: UseCases;
let queues: QueueUrls;
let reader: SQSClient;

beforeAll(async () => {
  [pg, sqs] = await Promise.all([startPostgres(), startSqs()]);
  await migrateUp(pg.migratorUrl);
  queues = await createTestQueues(sqs.endpoint);
  db = new Client({ connectionString: pg.migratorUrl });
  await db.connect();
  t = await createTestOrm(pg.appUrl);
  app = createUseCases(t);
  reader = testSqsClient(sqs.endpoint);
}, 180_000);

afterAll(async () => {
  Bun.spawnSync(['docker', 'unpause', sqs.container.getId()]);
  reader.destroy();
  await t.close();
  await db.end();
  await Promise.all([pg.stop(), sqs.stop()]);
});

beforeEach(async () => {
  await resetDatabase(pg.migratorUrl);
  await purge(reader, queues.eventsUrl);
});

function relay(
  instanceId: string,
  opts: {
    faults?: FaultInjector;
    leaseMs?: number;
    clock?: FakeClock;
    requestTimeoutMs?: number;
  } = {},
) {
  const client = createSqsClient({
    endpoint: sqs.endpoint,
    region: 'us-east-1',
    connectTimeoutMs: 1000,
    requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
  });

  return new OutboxRelay(
    t.runner(),
    new SqsEventPublisher(client, queues.eventsUrl),
    t.metrics,
    opts.clock ?? { now: () => new Date() },
    opts.faults ?? new NoopFaultInjector(),
    new NoopLogger(),
    {
      instanceId,
      leaseMs: opts.leaseMs ?? 30_000,
      pollMs: 50,
      batchSize: 50,
      retryBaseMs: 1000,
      retryCapMs: 300_000,
      random: () => 0.5,
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

async function pendingCount(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL',
  );

  return rows[0]?.n ?? 0;
}

describe('OutboxRelay', () => {
  test('publishes committed events byte for byte, grouped by wallet, with type and version attributes', async () => {
    const wallet = await openWallet();

    await app.processWager.execute(wagerCommand(wallet), { type: 'HTTP' });
    const { rows } = await db.query<{ id: string; payload_text: string }>(
      'SELECT id, payload::text AS payload_text FROM outbox_messages ORDER BY occurred_at, id',
    );

    expect(await relay('relay-1').tick()).toBe(4);
    const received = await receiveAll(reader, queues.eventsUrl, { waitMs: 5000, expected: 4 });

    expect(received.map((m) => m.body).sort()).toEqual(rows.map((row) => row.payload_text).sort());
    expect(received.every((m) => m.groupId === wallet.id)).toBe(true);
    expect(received.map((m) => m.deduplicationId).sort()).toEqual(rows.map((row) => row.id).sort());
    expect(new Set(received.map((m) => m.attributes['eventType']))).toEqual(
      new Set(['WagerTransactionProcessed', 'WalletBalanceChanged']),
    );
    expect(received.every((m) => m.attributes['eventVersion'] === '1')).toBe(true);
    expect(await pendingCount()).toBe(0);
  });

  test('two relays over 200 events publish every event, none lost, all marked', async () => {
    const messages = Array.from({ length: 200 }, (_, i) => {
      const id = uuid();
      const at = new Date(Date.now() - 1000 + i);

      return OutboxMessage.rehydrate({
        id,
        aggregateId: `agg-${i % 7}`,
        partitionKey: `wallet-${i % 7}`,
        eventType: 'WalletBalanceChanged',
        eventVersion: 1,
        payload: { eventId: id, n: i },
        occurredAt: at,
        attempts: 0,
        nextAttemptAt: at,
        publishedAt: null,
      });
    });

    await t.runner().run((tx) => tx.outbox.insertMany(messages));
    const a = relay('relay-a');
    const b = relay('relay-b');
    const drain = async (r: OutboxRelay) => {
      while ((await r.tick()) > 0) {
        continue;
      }
    };

    await Promise.all([drain(a), drain(b)]);
    const received = await receiveAll(reader, queues.eventsUrl, { waitMs: 15_000, expected: 200 });
    const eventIds = new Set(
      received.map((m) => (JSON.parse(m.body) as { eventId: string }).eventId),
    );

    expect(eventIds).toEqual(new Set(messages.map((m) => m.id)));
    expect(await pendingCount()).toBe(0);
  }, 60_000);

  test('a relay that dies after publishing and before marking is taken over after the lease; the consumer sees one logical event', async () => {
    await openWallet();
    const { rows } = await db.query<{ id: string }>('SELECT id FROM outbox_messages');
    const dying = relay('relay-a', {
      faults: new ThrowingFaultInjector('after-publish-before-mark'),
      leaseMs: 1000,
    });
    const survivor = relay('relay-b', { leaseMs: 1000 });
    let died = false;

    try {
      await dying.tick();
    } catch {
      died = true;
    }

    expect(died).toBe(true);
    expect(await survivor.tick()).toBe(0);
    await waitUntil(async () => (await survivor.tick()) > 0, {
      timeoutMs: 10_000,
      intervalMs: 200,
    });
    while ((await survivor.tick()) > 0) {
      continue;
    }
    expect(await pendingCount()).toBe(0);
    const received = await receiveAll(reader, queues.eventsUrl, { waitMs: 3000 });
    const logical = new Set(
      received.map((m) => (JSON.parse(m.body) as { eventId: string }).eventId),
    );

    expect(logical).toEqual(new Set(rows.map((row) => row.id)));
    for (const eventId of logical) {
      expect(
        new Set(received.filter((m) => m.body.includes(eventId)).map((m) => m.body)).size,
      ).toBe(1);
    }
  }, 30_000);

  test('with SQS down the attempts grow with backoff and nothing is lost; once it is back the event is published', async () => {
    await openWallet();
    const clock = new FakeClock();
    const r = relay('relay-1', { clock, requestTimeoutMs: 1000 });

    Bun.spawnSync(['docker', 'pause', sqs.container.getId()]);
    try {
      expect(await r.tick()).toBe(0);
    } finally {
      Bun.spawnSync(['docker', 'unpause', sqs.container.getId()]);
    }
    const { rows } = await db.query<{
      attempts: number;
      next_attempt_at: Date;
      last_error: string | null;
    }>(
      'SELECT attempts, next_attempt_at, last_error FROM outbox_messages ORDER BY occurred_at, id',
    );
    const [first, ...rest] = rows;

    expect(rows.length).toBe(2);
    expect(first?.attempts).toBe(1);
    expect(first?.last_error).not.toBeNull();
    expect(rest.every((row) => row.attempts === 0)).toBe(true);
    expect(
      rows.every((row) => row.next_attempt_at.getTime() === clock.now().getTime() + 1000),
    ).toBe(true);
    expect(t.metrics.counter('outbox_publish_retries_total')).toBeGreaterThanOrEqual(1);
    expect(await r.tick()).toBe(0);
    clock.advance(1000);
    expect(await r.tick()).toBe(rows.length);
    expect(await pendingCount()).toBe(0);
  }, 60_000);

  test('an event of a transaction that is still open is invisible to the relay until it commits', async () => {
    const wallet = await openWallet();
    const r = relay('relay-1');

    while ((await r.tick()) > 0) {
      continue;
    }
    await purge(reader, queues.eventsUrl);
    const gate = new BlockingFaultInjector('before-commit');
    const blocked = createUseCases(t, { faults: gate });
    const running = blocked.processWager.execute(wagerCommand(wallet), { type: 'HTTP' });

    await gate.reached;
    expect(await r.tick()).toBe(0);
    gate.open();
    await running;
    expect(await r.tick()).toBe(2);
  });

  test('start and stop run the polling loop and publish without explicit ticks', async () => {
    await openWallet();
    const r = relay('relay-loop');

    r.start();
    await waitUntil(async () => (await pendingCount()) === 0, { timeoutMs: 10_000 });
    await r.stop();

    expect(t.metrics.gauge('outbox_lag_seconds')).toBeDefined();
    expect(t.metrics.allObservations('outbox_publish_duration_seconds').length).toBeGreaterThan(0);
  });
});
