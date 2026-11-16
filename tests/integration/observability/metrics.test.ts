import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { uuid } from '../../support/builders';
import { startTestApi, type TestApi } from '../../support/http';
import { testSqsClient } from '../../support/sqs';
import { waitUntil } from '../../support/wait-until';
import { DlqDepthCollector } from '../../../src/modules/observability/dlq-depth.collector';
import { MetricsServer } from '../../../src/modules/observability/metrics-server';
import { PrometheusMetrics } from '../../../src/modules/observability/prometheus-metrics';
import { NoopLogger } from '../../../src/modules/observability/logger.port';

const METRIC_NAMES = [
  'wager_transactions_total',
  'idempotent_replays_total',
  'inbox_duplicates_total',
  'processing_retries_total',
  'dlq_messages_total',
  'lock_conflicts_total',
  'db_deadlocks_total',
  'outbox_lag_seconds',
  'processing_duration_seconds',
  'reconciliation_divergence_total',
  'inbox_payload_conflict_total',
  'outbox_publish_retries_total',
  'jwks_fetch_failures_total',
  'wallet_lock_wait_seconds',
  'db_transaction_duration_seconds',
  'outbox_publish_duration_seconds',
  'dlq_depth',
  'idempotency_conflicts_total',
];

let api: TestApi;
let metrics: PrometheusMetrics;
let server: MetricsServer;

beforeAll(async () => {
  metrics = new PrometheusMetrics();
  api = await startTestApi({ metrics }, { roles: 'api,outbox-relay' });
  server = new MetricsServer(metrics, 0);
  server.start();
}, 180_000);

afterAll(async () => {
  server.stop();
  await api.stop();
});

async function scrape(): Promise<string> {
  return (await fetch(`http://127.0.0.1:${server.port()}/metrics`)).text();
}

describe('Prometheus metrics', () => {
  test('the internal port exposes every metric name of the design, and the API port does not serve /metrics', async () => {
    const body = await scrape();

    for (const name of METRIC_NAMES) {
      expect(body).toContain(`# TYPE ${name} `);
    }
    expect((await api.request('GET', '/metrics', { token: null })).status).toBe(404);
  });

  test('replays, conflicts, processing latency and the outbox lag are counted', async () => {
    const playerId = uuid();
    const created = await api.request('POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    const token = await api.providerToken('provider-a');
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'metrics-1',
      playerId,
      walletId: String(created.json['id']),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const send = (payload: object) =>
      api.request('POST', '/wagering/transactions', {
        token,
        body: payload,
        headers: { 'idempotency-key': 'provider-a:metrics-1' },
      });

    await send(body);
    await send(body);
    expect((await send({ ...body, money: { amount: '11.00', currency: 'BRL' } })).status).toBe(409);
    await waitUntil(async () => /outbox_lag_seconds \d/.test(await scrape()), {
      timeoutMs: 10_000,
    });
    const scraped = await scrape();

    expect(scraped).toMatch(/idempotent_replays_total\{channel="HTTP"\} [1-9]/);
    expect(scraped).toMatch(/wager_transactions_total\{status="PROCESSED",kind="BET"\} 1/);
    expect(scraped).toMatch(/processing_duration_seconds_count\{channel="HTTP"\} [1-9]/);
    expect(scraped).toMatch(/idempotency_conflicts_total\{channel="HTTP"\} 1/);
    expect(scraped).not.toMatch(/amount/);
  });

  test('dlq_depth reflects a message placed in the DLQ', async () => {
    const sqs = testSqsClient(api.sqs.endpoint);
    const collector = new DlqDepthCollector(
      sqs,
      api.config.sqs.wagerDlqUrl,
      metrics,
      new NoopLogger(),
      {
        intervalMs: 200,
        timeoutMs: 3000,
      },
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: api.config.sqs.wagerDlqUrl,
        MessageBody: '{}',
        MessageGroupId: 'g',
        MessageDeduplicationId: uuid(),
      }),
    );
    collector.start();
    try {
      await waitUntil(async () => /\ndlq_depth 1\b/.test(await scrape()), { timeoutMs: 15_000 });
    } finally {
      collector.stop();
      sqs.destroy();
    }
  }, 30_000);
});
