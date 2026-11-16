// Composition root: wires persistence, use cases, identity, HTTP controllers and health from the validated config.
import {
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { APP_SETTINGS, CLOCK, FAULTS, IDS, LOGGER, METRICS, SQS_CLIENT } from './app.tokens';
import type { AppOptions } from './app.module.types';
import { appOrmConfig } from './infrastructure/db/mikro-orm.config';
import { WalletTransactionRunner } from './infrastructure/db/wallet-transaction-runner';
import { NoopFaultInjector, type FaultInjector } from './infrastructure/fault/fault-injector';
import { OpenApiController } from './infrastructure/http/openapi.controller';
import { ProblemDetailsFilter } from './infrastructure/http/problem-details.filter';
import { HealthController } from './modules/health/health.controller';
import { ReadinessProbe, ShutdownState } from './modules/health/readiness';
import { JwtProviderIdentity } from './modules/identity/jwks-key-source';
import { JwtAuthGuard } from './modules/identity/jwt-auth.guard';
import { PROVIDER_IDENTITY } from './modules/identity/provider-identity.port';
import { EventFactory } from './modules/messaging/domain/event-factory';
import { createSqsClient } from './modules/messaging/infrastructure/sqs-client';
import { NoopLogger, type AppLogger } from './modules/observability/logger.port';
import { NoopMetrics, type MetricsPort } from './modules/observability/metrics.port';
import { GetTransaction } from './modules/wagering/application/get-transaction';
import { ProcessWagerTransaction } from './modules/wagering/application/process-wager-transaction';
import { WagerProcessor } from './modules/wagering/application/wager-processor';
import { ProvidersController } from './modules/wagering/interface/providers.controller';
import { WageringController } from './modules/wagering/interface/wagering.controller';
import { GetWallet } from './modules/wallet/application/get-wallet';
import { ListLedger } from './modules/wallet/application/list-ledger';
import { OpenWallet } from './modules/wallet/application/open-wallet';
import { ReconcileWallet } from './modules/wallet/application/reconcile-wallet';
import { WalletsController } from './modules/wallet/interface/wallets.controller';
import type { AppConfig } from './config/config.schema';
import { UuidV7Generator, type IdGenerator } from './shared/ids/id-generator';
import { SystemClock, type Clock } from './shared/time/clock';

class ResourceCloser implements OnApplicationShutdown {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}

function factory<T>(
  provide: unknown,
  inject: unknown[],
  useFactory: (...args: never[]) => T,
): Provider {
  return { provide: provide as never, inject: inject as never[], useFactory };
}

function providers(options: AppOptions): Provider[] {
  const { config } = options;

  return [
    { provide: APP_SETTINGS, useValue: config },
    { provide: METRICS, useValue: options.metrics ?? new NoopMetrics() },
    { provide: LOGGER, useValue: options.logger ?? new NoopLogger() },
    { provide: CLOCK, useValue: options.clock ?? new SystemClock() },
    { provide: IDS, useValue: new UuidV7Generator() },
    { provide: FAULTS, useValue: options.faults ?? new NoopFaultInjector() },
    { provide: ShutdownState, useValue: options.shutdownState ?? new ShutdownState() },
    factory(MikroORM, [], () =>
      MikroORM.init(
        appOrmConfig({
          clientUrl: config.databaseUrl,
          poolSize: config.db.poolSize,
          connectTimeoutMs: config.db.connectTimeoutMs,
          acquireTimeoutMs: config.db.acquireTimeoutMs,
          queryTimeoutMs: config.db.queryTimeoutMs,
        }),
      ),
    ),
    factory(SQS_CLIENT, [], () =>
      createSqsClient({
        endpoint: config.sqs.endpoint,
        region: config.sqs.region,
        connectTimeoutMs: config.sqs.connectTimeoutMs,
        requestTimeoutMs: config.sqs.requestTimeoutMs,
      }),
    ),
    ResourceCloser,
    factory(
      WalletTransactionRunner,
      [MikroORM, METRICS],
      (orm: MikroORM, metrics: MetricsPort) =>
        new WalletTransactionRunner(orm.em, metrics, {
          lockTimeoutMs: config.db.lockTimeoutMs,
          statementTimeoutMs: config.db.statementTimeoutMs,
          idleInTxTimeoutMs: config.db.idleInTxTimeoutMs,
        }),
    ),
    factory(
      EventFactory,
      [IDS, CLOCK],
      (ids: IdGenerator, clock: Clock) => new EventFactory(ids, clock),
    ),
    factory(
      WagerProcessor,
      [EventFactory, IDS, CLOCK, METRICS, FAULTS],
      (
        events: EventFactory,
        ids: IdGenerator,
        clock: Clock,
        metrics: MetricsPort,
        faults: FaultInjector,
      ) =>
        new WagerProcessor(events, ids, clock, metrics, faults, {
          pendingTtlMs: config.pendingReferenceTtlMs,
          pendingFirstRetryMs: config.pending.retryBaseMs,
        }),
    ),
    factory(
      ProcessWagerTransaction,
      [WalletTransactionRunner, WagerProcessor, EventFactory, IDS, CLOCK, METRICS, FAULTS],
      (
        runner: WalletTransactionRunner,
        processor: WagerProcessor,
        events: EventFactory,
        ids: IdGenerator,
        clock: Clock,
        metrics: MetricsPort,
        faults: FaultInjector,
      ) => new ProcessWagerTransaction(runner, processor, events, ids, clock, metrics, faults),
    ),
    factory(
      OpenWallet,
      [WalletTransactionRunner, EventFactory, IDS, CLOCK],
      (runner: WalletTransactionRunner, events: EventFactory, ids: IdGenerator, clock: Clock) =>
        new OpenWallet(runner, events, ids, clock),
    ),
    factory(
      GetWallet,
      [WalletTransactionRunner],
      (runner: WalletTransactionRunner) => new GetWallet(runner),
    ),
    factory(
      ListLedger,
      [WalletTransactionRunner],
      (runner: WalletTransactionRunner) => new ListLedger(runner),
    ),
    factory(
      GetTransaction,
      [WalletTransactionRunner],
      (runner: WalletTransactionRunner) => new GetTransaction(runner),
    ),
    factory(
      ReconcileWallet,
      [WalletTransactionRunner, METRICS, LOGGER],
      (runner: WalletTransactionRunner, metrics: MetricsPort, logger: AppLogger) =>
        new ReconcileWallet(runner, metrics, logger),
    ),
    factory(
      ReadinessProbe,
      [MikroORM, SQS_CLIENT, ShutdownState],
      (orm: MikroORM, sqs: SQSClient, state: ShutdownState) =>
        new ReadinessProbe(orm, sqs, state, {
          queueUrl: config.sqs.wagerQueueUrl,
          timeoutMs: config.health.timeoutMs,
        }),
    ),
    factory(
      PROVIDER_IDENTITY,
      [METRICS],
      (metrics: MetricsPort) =>
        options.identity ??
        new JwtProviderIdentity(
          {
            issuer: config.auth.issuer,
            audience: config.auth.audience,
            jwksUrl: config.auth.jwksUrl,
            timeoutMs: config.health.timeoutMs,
          },
          metrics,
        ),
    ),
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    factory(APP_FILTER, [LOGGER], (logger: AppLogger) => new ProblemDetailsFilter(logger)),
  ];
}

@Module({})
export class AppModule {
  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        WalletsController,
        WageringController,
        ProvidersController,
        HealthController,
        OpenApiController,
      ],
      providers: providers(options),
    };
  }
}

export type { AppConfig };
