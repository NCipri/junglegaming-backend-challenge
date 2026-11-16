// Environment configuration: validation, defaults and the typed AppConfig.
import { z } from 'zod';

export const APP_ROLES = [
  'api',
  'sqs-consumer',
  'outbox-relay',
  'pending-reference-worker',
] as const;
export type AppRole = (typeof APP_ROLES)[number];

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigValidationError';
  }
}

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const url = z.url();

const roles = z
  .string()
  .min(1)
  .transform((raw) => raw.split(',').map((r) => r.trim()))
  .pipe(z.array(z.enum(APP_ROLES)).min(1));

const envSchema = z.object({
  DATABASE_URL: url,
  DATABASE_MIGRATOR_URL: url,
  SQS_ENDPOINT: url,
  SQS_REGION: z.string().min(1),
  SQS_WAGER_QUEUE_URL: url,
  SQS_WAGER_DLQ_URL: url,
  SQS_EVENTS_QUEUE_URL: url,
  APP_ROLES: roles,
  AUTH_ISSUER: url,
  AUTH_AUDIENCE: z.string().min(1),
  AUTH_JWKS_URL: url,
  INSTANCE_ID: z.string().min(1),
  HTTP_PORT: int(3000),
  METRICS_PORT: int(9464),
  PENDING_REFERENCE_TTL_MS: int(86_400_000),
  DB_POOL_SIZE: int(10),
  DB_CONNECT_TIMEOUT_MS: int(5000),
  DB_QUERY_TIMEOUT_MS: int(15000),
  DB_ACQUIRE_TIMEOUT_MS: int(5000),
  DB_LOCK_TIMEOUT_MS: int(5000),
  DB_STATEMENT_TIMEOUT_MS: int(10000),
  DB_IDLE_IN_TX_TIMEOUT_MS: int(30000),
  SQS_REQUEST_TIMEOUT_MS: int(10000),
  SQS_CONNECT_TIMEOUT_MS: int(5000),
  SQS_WAIT_TIME_SECONDS: int(20),
  SQS_VISIBILITY_TIMEOUT_SECONDS: int(30),
  SQS_HEARTBEAT_SECONDS: int(10),
  SQS_RETRY_BASE_SECONDS: int(15),
  SQS_RETRY_CAP_SECONDS: int(300),
  OUTBOX_LEASE_MS: int(30000),
  OUTBOX_POLL_MS: int(500),
  OUTBOX_BATCH_SIZE: int(50),
  OUTBOX_RETRY_BASE_MS: int(1000),
  OUTBOX_RETRY_CAP_MS: int(300000),
  PENDING_LEASE_MS: int(30000),
  PENDING_POLL_MS: int(1000),
  PENDING_BATCH_SIZE: int(50),
  PENDING_RETRY_BASE_MS: int(1000),
  PENDING_RETRY_CAP_MS: int(300000),
  SHUTDOWN_GRACE_MS: int(20000),
  HEALTH_TIMEOUT_MS: int(3000),
});

export type AppConfig = ReturnType<typeof toAppConfig>;

function toAppConfig(env: z.infer<typeof envSchema>) {
  return {
    databaseUrl: env.DATABASE_URL,
    databaseMigratorUrl: env.DATABASE_MIGRATOR_URL,
    roles: env.APP_ROLES,
    instanceId: env.INSTANCE_ID,
    pendingReferenceTtlMs: env.PENDING_REFERENCE_TTL_MS,
    http: { port: env.HTTP_PORT },
    metrics: { port: env.METRICS_PORT },
    auth: { issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE, jwksUrl: env.AUTH_JWKS_URL },
    db: {
      poolSize: env.DB_POOL_SIZE,
      connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS,
      acquireTimeoutMs: env.DB_ACQUIRE_TIMEOUT_MS,
      lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
      idleInTxTimeoutMs: env.DB_IDLE_IN_TX_TIMEOUT_MS,
    },
    sqs: {
      endpoint: env.SQS_ENDPOINT,
      region: env.SQS_REGION,
      wagerQueueUrl: env.SQS_WAGER_QUEUE_URL,
      wagerDlqUrl: env.SQS_WAGER_DLQ_URL,
      eventsQueueUrl: env.SQS_EVENTS_QUEUE_URL,
      requestTimeoutMs: env.SQS_REQUEST_TIMEOUT_MS,
      connectTimeoutMs: env.SQS_CONNECT_TIMEOUT_MS,
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      heartbeatSeconds: env.SQS_HEARTBEAT_SECONDS,
      retryBaseSeconds: env.SQS_RETRY_BASE_SECONDS,
      retryCapSeconds: env.SQS_RETRY_CAP_SECONDS,
    },
    outbox: {
      leaseMs: env.OUTBOX_LEASE_MS,
      pollMs: env.OUTBOX_POLL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      retryBaseMs: env.OUTBOX_RETRY_BASE_MS,
      retryCapMs: env.OUTBOX_RETRY_CAP_MS,
    },
    pending: {
      leaseMs: env.PENDING_LEASE_MS,
      pollMs: env.PENDING_POLL_MS,
      batchSize: env.PENDING_BATCH_SIZE,
      retryBaseMs: env.PENDING_RETRY_BASE_MS,
      retryCapMs: env.PENDING_RETRY_CAP_MS,
    },
    shutdown: { graceMs: env.SHUTDOWN_GRACE_MS },
    health: { timeoutMs: env.HEALTH_TIMEOUT_MS },
  } as const;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  return toAppConfig(parsed.data);
}
