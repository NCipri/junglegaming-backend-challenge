import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { spawnApp, type AppProcess } from './app-process';
import { startPostgres, startSqs, type TestPostgres, type TestSqs } from './containers';
import { migrateUp } from './database';
import { startTestIssuer, TEST_AUDIENCE, TEST_ISSUER, type TestIssuer } from './jwt';
import { createTestQueues, testSqsClient } from './sqs';
import { uuid } from './builders';
import type { QueueUrls } from '../../src/modules/messaging/infrastructure/sqs-topology';

export const ALL_ROLES = 'api,sqs-consumer,outbox-relay,pending-reference-worker';

export interface Cluster {
  pg: TestPostgres;
  sqs: TestSqs;
  issuer: TestIssuer;
  queues: QueueUrls;
  db: Client;
  sqsClient: SQSClient;
  apps: AppProcess[];
  operatorToken: string;
  providerToken: string;
  baseEnv(queues?: QueueUrls): Record<string, string>;
  spawn(
    name: string,
    opts?: { roles?: string; env?: Record<string, string>; queues?: QueueUrls },
  ): Promise<AppProcess>;
  request(
    app: AppProcess,
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  openWallet(amount: string, app?: AppProcess): Promise<{ id: string; playerId: string }>;
  sendMessage(
    data: Record<string, unknown>,
    opts?: { messageId?: string; groupId?: string; queueUrl?: string; fifo?: boolean },
  ): Promise<string>;
  stop(): Promise<void>;
}

export async function startCluster(): Promise<Cluster> {
  const [pg, sqs, issuer] = await Promise.all([startPostgres(), startSqs(), startTestIssuer()]);

  await migrateUp(pg.migratorUrl);
  const queues = await createTestQueues(sqs.endpoint);
  const db = new Client({ connectionString: pg.migratorUrl });

  await db.connect();
  const sqsClient = testSqsClient(sqs.endpoint);
  const operatorToken = await issuer.signToken({
    clientId: 'backoffice',
    roles: ['operator'],
    expiresIn: '1h',
  });
  const providerToken = await issuer.signToken({
    clientId: 'provider-a',
    roles: ['provider'],
    expiresIn: '1h',
  });
  const apps: AppProcess[] = [];
  const baseEnv = (q: QueueUrls = queues): Record<string, string> => ({
    DATABASE_URL: pg.appUrl,
    DATABASE_MIGRATOR_URL: pg.migratorUrl,
    SQS_ENDPOINT: sqs.endpoint,
    SQS_REGION: 'us-east-1',
    SQS_WAGER_QUEUE_URL: q.wagerUrl,
    SQS_WAGER_DLQ_URL: q.dlqUrl,
    SQS_EVENTS_QUEUE_URL: q.eventsUrl,
    AUTH_ISSUER: TEST_ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    AUTH_JWKS_URL: issuer.jwksUrl,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    SQS_HEARTBEAT_SECONDS: '2',
    SQS_RETRY_BASE_SECONDS: '1',
    OUTBOX_POLL_MS: '100',
    PENDING_POLL_MS: '100',
    SHUTDOWN_GRACE_MS: '5000',
  });
  const cluster: Cluster = {
    pg,
    sqs,
    issuer,
    queues,
    db,
    sqsClient,
    apps,
    operatorToken,
    providerToken,
    baseEnv,
    spawn: async (name, opts = {}) => {
      const app = spawnApp({
        name,
        roles: opts.roles ?? ALL_ROLES,
        env: { ...baseEnv(opts.queues), ...opts.env },
      });

      apps.push(app);
      await app.waitReady();

      return app;
    },
    request: async (app, method, path, opts = {}) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${opts.token ?? operatorToken}`,
        ...opts.headers,
      };

      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      const response = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      const text = await response.text();

      return {
        status: response.status,
        json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      };
    },
    openWallet: async (amount, app) => {
      const target = app ?? apps[0];

      if (!target) {
        throw new Error('no app running');
      }
      const playerId = uuid();
      const res = await cluster.request(target, 'POST', '/wallets', {
        body: { playerId, initialBalance: { amount, currency: 'BRL' } },
      });

      if (res.status !== 201) {
        throw new Error(`openWallet failed: ${res.status}`);
      }

      return { id: String(res.json['id']), playerId };
    },
    sendMessage: async (data, opts = {}) => {
      const messageId = opts.messageId ?? uuid();
      const fifo = opts.fifo ?? true;

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: opts.queueUrl ?? queues.wagerUrl,
          MessageBody: JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data,
          }),
          ...(fifo
            ? {
                MessageGroupId: opts.groupId ?? String(data['walletId']),
                MessageDeduplicationId: uuid(),
              }
            : {}),
        }),
      );

      return messageId;
    },
    stop: async () => {
      for (const app of apps) {
        app.kill('SIGKILL');
      }
      await Promise.all(apps.map((app) => app.exited));
      sqsClient.destroy();
      await db.end();
      issuer.stop();
      await Promise.all([pg.stop(), sqs.stop()]);
    },
  };

  return cluster;
}

export function wagerData(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const requested = overrides['externalTransactionId'];
  const externalTransactionId = typeof requested === 'string' ? requested : `ext-${uuid()}`;

  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export function httpBody(data: Record<string, unknown>): Record<string, unknown> {
  const body = { ...data };

  delete body['idempotencyKey'];

  return body;
}
