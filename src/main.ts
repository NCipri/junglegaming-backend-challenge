// Process entry point: starts the roles in APP_ROLES; SIGTERM → readiness 503, drains consumer and HTTP in parallel, closes, exits 0.
import 'reflect-metadata';
import { loadConfig } from './config/config.schema';
import { RoleRunner } from './app.module';
import { createHttpApp } from './http-app';
import { InFlightRequests } from './infrastructure/http/in-flight';
import { ShutdownState } from './modules/health/readiness';
import { parseFaultInjection } from './infrastructure/fault/fault-injector';
import { MetricsServer } from './modules/observability/metrics-server';
import { createPinoLogger } from './modules/observability/pino-logger';
import { PrometheusMetrics } from './modules/observability/prometheus-metrics';

const HARD_STOP_MS = 28_000;

const config = loadConfig(process.env);
const logger = createPinoLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  instanceId: config.instanceId,
});
const faults = parseFaultInjection(process.env.FAULT_INJECTION);
const metrics = new PrometheusMetrics();
const metricsServer = new MetricsServer(metrics, config.metrics.port);
const inFlight = new InFlightRequests();
const app = await createHttpApp(
  {
    config,
    logger,
    metrics,
    faults,
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
    logger.flush();
    process.exit(1);
  }, HARD_STOP_MS);
  let exitCode = 0;

  try {
    await faults.hit('during-shutdown');
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
  } catch (error) {
    exitCode = 1;
    logger.error(
      { signal, error: error instanceof Error ? error.message : String(error) },
      'Shutdown failed',
    );
  } finally {
    clearTimeout(hardStop);
  }
  logger.flush();
  process.exit(exitCode);
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
  {
    roles: config.roles,
    httpPort: config.http.port,
    metricsPort: config.metrics.port,
    faultInjection: process.env.FAULT_INJECTION ?? null,
  },
  'Instance started',
);
