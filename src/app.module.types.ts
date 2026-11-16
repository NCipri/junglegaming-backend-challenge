// Options of the composition root; tests replace ports such as metrics, logger, clock and faults.
import type { AppConfig } from './config/config.schema';
import type { FaultInjector } from './infrastructure/fault/fault-injector';
import type { ShutdownState } from './modules/health/readiness';
import type { ProviderIdentityPort } from './modules/identity/provider-identity.port';
import type { AppLogger } from './modules/observability/logger.port';
import type { MetricsPort } from './modules/observability/metrics.port';
import type { Clock } from './shared/time/clock';

export interface AppOptions {
  config: AppConfig;
  metrics?: MetricsPort;
  logger?: AppLogger;
  clock?: Clock;
  faults?: FaultInjector;
  identity?: ProviderIdentityPort;
  shutdownState?: ShutdownState;
}
