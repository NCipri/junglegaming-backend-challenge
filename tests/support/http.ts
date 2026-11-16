import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig, type AppConfig } from '../../src/config/config.schema';
import { createHttpApp } from '../../src/http-app';
import type { AppOptions } from '../../src/app.module.types';
import { startPostgres, startSqs, type TestPostgres, type TestSqs } from './containers';
import { migrateUp } from './database';
import { startTestIssuer, TEST_AUDIENCE, TEST_ISSUER, type TestIssuer } from './jwt';
import { InMemoryMetrics } from './metrics';
import { createTestQueues } from './sqs';
import { RecordingLogger } from './use-cases';

export interface TestApi {
  pg: TestPostgres;
  sqs: TestSqs;
  issuer: TestIssuer;
  app: NestExpressApplication;
  config: AppConfig;
  metrics: InMemoryMetrics;
  logger: RecordingLogger;
  baseUrl: string;
  operatorToken: string;
  providerToken(providerId: string): Promise<string>;
  request(method: string, path: string, opts?: RequestOptions): Promise<ApiResponse>;
  stop(): Promise<void>;
}

export interface RequestOptions {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown>;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function testConfig(env: Record<string, string>): AppConfig {
  return loadConfig({
    APP_ROLES: 'api',
    INSTANCE_ID: 'test-instance',
    SQS_REGION: 'us-east-1',
    AUTH_ISSUER: TEST_ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    ...env,
  });
}

export async function startTestApi(overrides: Partial<AppOptions> = {}): Promise<TestApi> {
  const [pg, sqs, issuer] = await Promise.all([startPostgres(), startSqs(), startTestIssuer()]);

  await migrateUp(pg.migratorUrl);
  const queues = await createTestQueues(sqs.endpoint);
  const config = testConfig({
    DATABASE_URL: pg.appUrl,
    DATABASE_MIGRATOR_URL: pg.migratorUrl,
    SQS_ENDPOINT: sqs.endpoint,
    SQS_WAGER_QUEUE_URL: queues.wagerUrl,
    SQS_WAGER_DLQ_URL: queues.dlqUrl,
    SQS_EVENTS_QUEUE_URL: queues.eventsUrl,
    AUTH_JWKS_URL: issuer.jwksUrl,
  });
  const metrics = new InMemoryMetrics();
  const logger = new RecordingLogger();
  const app = await createHttpApp({ config, metrics, logger, ...overrides });

  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const operatorToken = await issuer.signToken({ clientId: 'operator-cli', roles: ['operator'] });

  return {
    pg,
    sqs,
    issuer,
    app,
    config,
    metrics,
    logger,
    baseUrl,
    operatorToken,
    providerToken: (providerId) => issuer.signToken({ clientId: providerId, roles: ['provider'] }),
    request: async (method, path, opts = {}) => {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };

      if (opts.token !== null) {
        headers['authorization'] = `Bearer ${opts.token ?? operatorToken}`;
      }
      let body: string | undefined = opts.rawBody;

      if (opts.body !== undefined) {
        headers['content-type'] ??= 'application/json';
        body = JSON.stringify(opts.body);
      }
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const text = await response.text();
      const json = parseJson(text);

      return { status: response.status, headers: response.headers, text, json };
    },
    stop: async () => {
      await app.close();
      issuer.stop();
      await Promise.all([pg.stop(), sqs.stop()]);
    },
  };
}
