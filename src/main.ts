// Process entry point: validates the environment, starts the roles listed in APP_ROLES and the internal metrics port.
import 'reflect-metadata';
import { loadConfig } from './config/config.schema';
import { createHttpApp } from './http-app';
import { MetricsServer } from './modules/observability/metrics-server';
import { createPinoLogger } from './modules/observability/pino-logger';
import { PrometheusMetrics } from './modules/observability/prometheus-metrics';

const config = loadConfig(process.env);
const logger = createPinoLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  instanceId: config.instanceId,
});
const metrics = new PrometheusMetrics();
const metricsServer = new MetricsServer(metrics, config.metrics.port);
const app = await createHttpApp({ config, logger, metrics });

metricsServer.start();
if (config.roles.includes('api')) {
  await app.listen(config.http.port);
} else {
  await app.init();
}
logger.info(
  { roles: config.roles, httpPort: config.http.port, metricsPort: config.metrics.port },
  'Instance started',
);
process.once('SIGTERM', () => metricsServer.stop());
