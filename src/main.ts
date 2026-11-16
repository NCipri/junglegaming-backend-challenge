// Process entry point: starts the roles in APP_ROLES; SIGTERM → readiness 503, drains consumer and HTTP in parallel, closes, exits 0.
import 'reflect-metadata';
import { loadConfig } from './config/config.schema';
import { RoleRunner } from './app.module';
import { createHttpApp } from './http-app';
import { InFlightRequests } from './infrastructure/http/in-flight';
import { ShutdownState } from './modules/health/readiness';
import {
  NoopFaultInjector,
  ProcessKillFaultInjector,
  type FaultPoint,
} from './infrastructure/fault/fault-injector';
import { MetricsServer } from './modules/observability/metrics-server';
import { createPinoLogger } from './modules/observability/pino-logger';
import { PrometheusMetrics } from './modules/observability/prometheus-metrics';

const FAULT_POINTS: readonly FaultPoint[] = [
  'after-ledger-insert',
  'before-commit',
  'after-commit-before-ack',
  'after-claim-before-publish',
  'after-publish-before-mark',
];
const HARD_STOP_MS = 28_000;

const config = loadConfig(process.env);
const logger = createPinoLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  instanceId: config.instanceId,
});
const faultPoint = FAULT_POINTS.find((point) => point === process.env.FAULT_INJECTION) ?? null;
const metrics = new PrometheusMetrics();
const metricsServer = new MetricsServer(metrics, config.metrics.port);
const inFlight = new InFlightRequests();
const app = await createHttpApp(
  {
    config,
    logger,
    metrics,
    faults: faultPoint ? new ProcessKillFaultInjector(faultPoint) : new NoopFaultInjector(),
  },
  inFlight,
);
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ signal }, 'Shutdown started');
  const hardStop = setTimeout(() => {
    logger.error({ signal }, 'Shutdown exceeded the grace period');
    process.exit(1);
  }, HARD_STOP_MS);

  try {
    app.get(ShutdownState).begin();
    const [, httpDrained] = await Promise.all([
      app.get(RoleRunner).drain(),
      inFlight.waitForIdle(config.shutdown.graceMs),
    ]);

    if (!httpDrained) {
      logger.warn(
        { inFlight: inFlight.count() },
        'HTTP drain timed out; closing with requests in flight',
      );
    }
    await app.close();
    metricsServer.stop();
    logger.info({ signal }, 'Shutdown complete');
  } finally {
    clearTimeout(hardStop);
  }
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
metricsServer.start();
if (config.roles.includes('api')) {
  await app.listen(config.http.port);
} else {
  await app.init();
}
logger.info(
  { roles: config.roles, httpPort: config.http.port, metricsPort: config.metrics.port, faultPoint },
  'Instance started',
);
