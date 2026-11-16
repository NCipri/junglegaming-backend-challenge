// Composition root: wires persistence, use cases, identity, HTTP controllers and health from the validated config.
import {
  Inject,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type OnApplicationBootstrap,
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
import { OutboxRelay } from './modules/messaging/infrastructure/outbox-relay';
import { createSqsClient } from './modules/messaging/infrastructure/sqs-client';
import { SqsConsumer } from './modules/messaging/infrastructure/sqs-consumer';
import { SqsEventPublisher } from './modules/messaging/infrastructure/sqs-event-publisher';
import { DlqDepthCollector } from './modules/observability/dlq-depth.collector';
import { NoopLogger, type AppLogger } from './modules/observability/logger.port';
import { NoopMetrics, type MetricsPort } from './modules/observability/metrics.port';
import { GetTransaction } from './modules/wagering/application/get-transaction';
import { PendingReferenceWorker } from './modules/wagering/application/pending-reference.worker';
import { ResolvePendingReference } from './modules/wagering/application/resolve-pending-reference';
import { WagerMessageHandler } from './modules/wagering/interface/wager-message.handler';
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

export class RoleRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private draining: Promise<void> | null = null;

  constructor(
    @Inject(APP_SETTINGS) private readonly config: AppConfig,
    @Inject(ShutdownState) private readonly state: ShutdownState,
    @Inject(SqsConsumer) private readonly consumer: SqsConsumer,
    @Inject(OutboxRelay) private readonly relay: OutboxRelay,
    @Inject(PendingReferenceWorker) private readonly worker: PendingReferenceWorker,
    @Inject(DlqDepthCollector) private readonly dlqDepth: DlqDepthCollector,
  ) {}

  onApplicationBootstrap(): void {
    const roles = new Set(this.config.roles);

    if (roles.has('sqs-consumer')) {
      this.consumer.start();
      this.dlqDepth.start();
    }
    if (roles.has('outbox-relay')) {
      this.relay.start();
    }
    if (roles.has('pending-reference-worker')) {
      this.worker.start();
    }
  }

  drain(): Promise<void> {
    this.draining ??= this.stopRoles();

    return this.draining;
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.drain();
  }

  private async stopRoles(): Promise<void> {
    this.state.begin();
    this.dlqDepth.stop();
    await Promise.all([
      this.consumer.stop({ graceMs: this.config.shutdown.graceMs }),
      this.relay.stop(),
      this.worker.stop(),
    ]);
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
      [WalletTransactionRunner, WagerProcessor, EventFactory, IDS, CLOCK, METRICS, FAULTS, LOGGER],
      (
        runner: WalletTransactionRunner,
        processor: WagerProcessor,
        events: EventFactory,
        ids: IdGenerator,
        clock: Clock,
        metrics: MetricsPort,
        faults: FaultInjector,
        logger: AppLogger,
      ) =>
        new ProcessWagerTransaction(runner, processor, events, ids, clock, metrics, faults, logger),
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
    factory(
      ResolvePendingReference,
      [WalletTransactionRunner, WagerProcessor, CLOCK],
      (runner: WalletTransactionRunner, processor: WagerProcessor, clock: Clock) =>
        new ResolvePendingReference(runner, processor, clock, {
          retryBaseMs: config.pending.retryBaseMs,
          retryCapMs: config.pending.retryCapMs,
        }),
    ),
    factory(
      PendingReferenceWorker,
      [WalletTransactionRunner, ResolvePendingReference, CLOCK, LOGGER],
      (
        runner: WalletTransactionRunner,
        resolve: ResolvePendingReference,
        clock: Clock,
        logger: AppLogger,
      ) =>
        new PendingReferenceWorker(runner, resolve, clock, logger, {
          instanceId: config.instanceId,
          leaseMs: config.pending.leaseMs,
          pollMs: config.pending.pollMs,
          batchSize: config.pending.batchSize,
          concurrency: 4,
        }),
    ),
    factory(
      OutboxRelay,
      [WalletTransactionRunner, SQS_CLIENT, METRICS, CLOCK, FAULTS, LOGGER],
      (
        runner: WalletTransactionRunner,
        sqs: SQSClient,
        metrics: MetricsPort,
        clock: Clock,
        faults: FaultInjector,
        logger: AppLogger,
      ) =>
        new OutboxRelay(
          runner,
          new SqsEventPublisher(sqs, config.sqs.eventsQueueUrl),
          metrics,
          clock,
          faults,
          logger,
          {
            instanceId: config.instanceId,
            leaseMs: config.outbox.leaseMs,
            pollMs: config.outbox.pollMs,
            batchSize: config.outbox.batchSize,
            retryBaseMs: config.outbox.retryBaseMs,
            retryCapMs: config.outbox.retryCapMs,
          },
        ),
    ),
    factory(
      SqsConsumer,
      [SQS_CLIENT, ProcessWagerTransaction, METRICS, LOGGER, IDS, FAULTS],
      (
        sqs: SQSClient,
        processWager: ProcessWagerTransaction,
        metrics: MetricsPort,
        logger: AppLogger,
        ids: IdGenerator,
        faults: FaultInjector,
      ) =>
        new SqsConsumer(
          sqs,
          new WagerMessageHandler(),
          processWager,
          metrics,
          logger,
          ids,
          faults,
          {
            queueUrl: config.sqs.wagerQueueUrl,
            dlqUrl: config.sqs.wagerDlqUrl,
            consumerName: 'wager-transactions',
            waitTimeSeconds: config.sqs.waitTimeSeconds,
            visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
            heartbeatSeconds: config.sqs.heartbeatSeconds,
            retryBaseSeconds: config.sqs.retryBaseSeconds,
            retryCapSeconds: config.sqs.retryCapSeconds,
            maxMessages: 10,
          },
        ),
    ),
    factory(
      DlqDepthCollector,
      [SQS_CLIENT, METRICS, LOGGER],
      (sqs: SQSClient, metrics: MetricsPort, logger: AppLogger) =>
        new DlqDepthCollector(sqs, config.sqs.wagerDlqUrl, metrics, logger, {
          intervalMs: 15_000,
          timeoutMs: config.health.timeoutMs,
        }),
    ),
    RoleRunner,
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
