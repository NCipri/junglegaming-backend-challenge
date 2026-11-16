// Verifies the Nest ConfigModule exposes the validated AppConfig under APP_CONFIG.
import { afterEach, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, ConfigModule } from '../../../src/config/config.module';
import type { AppConfig } from '../../../src/config/config.schema';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

test('provides the AppConfig loaded from process.env', async () => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://app:app@localhost:5432/wagering',
    DATABASE_MIGRATOR_URL: 'postgresql://migrator:migrator@localhost:5432/wagering',
    SQS_ENDPOINT: 'http://localhost:4566',
    SQS_REGION: 'us-east-1',
    SQS_WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
    SQS_WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wallet-events.fifo',
    APP_ROLES: 'api',
    AUTH_ISSUER: 'http://localhost:8081/realms/wagering',
    AUTH_AUDIENCE: 'wagering-api',
    AUTH_JWKS_URL: 'http://localhost:8081/realms/wagering/protocol/openid-connect/certs',
    INSTANCE_ID: 'app-test',
  });
  const app = await NestFactory.createApplicationContext(ConfigModule, { logger: false });
  try {
    expect(app.get<AppConfig>(APP_CONFIG).instanceId).toBe('app-test');
  } finally {
    await app.close();
  }
});
