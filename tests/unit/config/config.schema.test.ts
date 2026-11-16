// Unit tests for environment configuration loading and validation.
import { describe, expect, test } from 'bun:test';
import { ConfigValidationError, loadConfig } from '../../../src/config/config.schema';

const validEnv = {
  DATABASE_URL: 'postgresql://app:app@localhost:5432/wagering',
  DATABASE_MIGRATOR_URL: 'postgresql://migrator:migrator@localhost:5432/wagering',
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_REGION: 'us-east-1',
  SQS_WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  SQS_WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wallet-events.fifo',
  APP_ROLES: 'api,sqs-consumer',
  AUTH_ISSUER: 'http://localhost:8081/realms/wagering',
  AUTH_AUDIENCE: 'wagering-api',
  AUTH_JWKS_URL: 'http://localhost:8081/realms/wagering/protocol/openid-connect/certs',
  INSTANCE_ID: 'app-1',
};

describe('loadConfig', () => {
  test('rejects an empty environment and names the missing DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigValidationError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  test('parses APP_ROLES into a list of roles', () => {
    expect(loadConfig(validEnv).roles).toEqual(['api', 'sqs-consumer']);
  });

  test('rejects an unknown role in APP_ROLES', () => {
    expect(() => loadConfig({ ...validEnv, APP_ROLES: 'api,cron' })).toThrow(/APP_ROLES/);
  });

  test('defaults the pending-reference TTL to 24 hours', () => {
    expect(loadConfig(validEnv).pendingReferenceTtlMs).toBe(86_400_000);
  });

  test('applies the documented defaults for db, sqs, outbox, pending, shutdown and health', () => {
    const config = loadConfig(validEnv);
    expect(config.db).toEqual({
      poolSize: 10,
      connectTimeoutMs: 5000,
      queryTimeoutMs: 15000,
      acquireTimeoutMs: 5000,
      lockTimeoutMs: 5000,
      statementTimeoutMs: 10000,
      idleInTxTimeoutMs: 30000,
    });
    expect(config.sqs).toMatchObject({
      requestTimeoutMs: 10000,
      connectTimeoutMs: 5000,
      waitTimeSeconds: 20,
      visibilityTimeoutSeconds: 30,
      heartbeatSeconds: 10,
      retryBaseSeconds: 15,
      retryCapSeconds: 300,
    });
    expect(config.outbox).toEqual({
      leaseMs: 30000,
      pollMs: 500,
      batchSize: 50,
      retryBaseMs: 1000,
      retryCapMs: 300000,
    });
    expect(config.pending).toEqual({
      leaseMs: 30000,
      pollMs: 1000,
      batchSize: 50,
      retryBaseMs: 1000,
      retryCapMs: 300000,
    });
    expect(config.http.port).toBe(3000);
    expect(config.metrics.port).toBe(9464);
    expect(config.shutdown.graceMs).toBe(20000);
    expect(config.health.timeoutMs).toBe(3000);
  });

  test('lets an environment variable override a default', () => {
    expect(loadConfig({ ...validEnv, OUTBOX_LEASE_MS: '1000' }).outbox.leaseMs).toBe(1000);
  });

  test('rejects a non-numeric override', () => {
    expect(() => loadConfig({ ...validEnv, OUTBOX_LEASE_MS: 'soon' })).toThrow(/OUTBOX_LEASE_MS/);
  });

  test('exposes the connection, queue and auth settings', () => {
    const config = loadConfig(validEnv);
    expect(config.databaseUrl).toBe(validEnv.DATABASE_URL);
    expect(config.databaseMigratorUrl).toBe(validEnv.DATABASE_MIGRATOR_URL);
    expect(config.sqs.wagerQueueUrl).toBe(validEnv.SQS_WAGER_QUEUE_URL);
    expect(config.auth).toEqual({
      issuer: validEnv.AUTH_ISSUER,
      audience: validEnv.AUTH_AUDIENCE,
      jwksUrl: validEnv.AUTH_JWKS_URL,
    });
    expect(config.instanceId).toBe('app-1');
  });
});
