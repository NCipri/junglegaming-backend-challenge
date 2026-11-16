import {
  FaultInjectedError,
  type FaultInjector,
  type FaultPoint,
} from '../../src/infrastructure/fault/fault-injector';
import { NoopFaultInjector } from '../../src/infrastructure/fault/fault-injector';
import { EventFactory } from '../../src/modules/messaging/domain/event-factory';
import type { AppLogger } from '../../src/modules/observability/logger.port';
import { GetTransaction } from '../../src/modules/wagering/application/get-transaction';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerCommand } from '../../src/modules/wagering/application/wager-command';
import { WagerProcessor } from '../../src/modules/wagering/application/wager-processor';
import { WagerKind } from '../../src/modules/wagering/domain/wager-kind';
import { GetWallet } from '../../src/modules/wallet/application/get-wallet';
import { ListLedger } from '../../src/modules/wallet/application/list-ledger';
import { OpenWallet } from '../../src/modules/wallet/application/open-wallet';
import { ReconcileWallet } from '../../src/modules/wallet/application/reconcile-wallet';
import { UuidV7Generator } from '../../src/shared/ids/id-generator';
import { SystemClock, type Clock } from '../../src/shared/time/clock';
import type { TestOrm } from './persistence';

export class ThrowingFaultInjector implements FaultInjector {
  constructor(private readonly point: FaultPoint) {}

  hit(point: FaultPoint): Promise<void> {
    if (point === this.point) {
      return Promise.reject(new FaultInjectedError(point));
    }

    return Promise.resolve();
  }
}

export class RecordingLogger implements AppLogger {
  readonly errors: { context: Record<string, unknown>; message: string }[] = [];

  info(): void {}

  warn(): void {}

  error(context: Record<string, unknown>, message: string): void {
    this.errors.push({ context, message });
  }
}

export interface UseCases {
  openWallet: OpenWallet;
  processWager: ProcessWagerTransaction;
  getWallet: GetWallet;
  listLedger: ListLedger;
  reconcile: ReconcileWallet;
  getTransaction: GetTransaction;
  logger: RecordingLogger;
}

export function createUseCases(
  t: TestOrm,
  opts: { faults?: FaultInjector; clock?: Clock; pendingTtlMs?: number } = {},
): UseCases {
  const ids = new UuidV7Generator();
  const clock = opts.clock ?? new SystemClock();
  const faults = opts.faults ?? new NoopFaultInjector();
  const logger = new RecordingLogger();
  const events = new EventFactory(ids, clock);
  const runner = t.runner();
  const processor = new WagerProcessor(events, ids, clock, t.metrics, faults, {
    pendingTtlMs: opts.pendingTtlMs ?? 86_400_000,
    pendingFirstRetryMs: 1000,
  });

  return {
    openWallet: new OpenWallet(runner, events, ids, clock),
    processWager: new ProcessWagerTransaction(
      runner,
      processor,
      events,
      ids,
      clock,
      t.metrics,
      faults,
    ),
    getWallet: new GetWallet(runner),
    listLedger: new ListLedger(runner),
    reconcile: new ReconcileWallet(runner, t.metrics, logger),
    getTransaction: new GetTransaction(runner),
    logger,
  };
}

let seq = 0;

export function wagerCommand(
  wallet: { id: string; playerId: string },
  overrides: Partial<WagerCommand> = {},
): WagerCommand {
  seq += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${Date.now()}-${seq}`;
  const providerId = overrides.providerId ?? 'provider-a';

  return {
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    correlationId: `corr-${seq}`,
    ...overrides,
  };
}

export class BlockingFaultInjector implements FaultInjector {
  private release: () => void = () => undefined;
  private readonly released: Promise<void>;
  private reachedResolve: () => void = () => undefined;
  readonly reached: Promise<void>;

  constructor(private readonly point: FaultPoint) {
    this.released = new Promise((resolve) => {
      this.release = resolve;
    });
    this.reached = new Promise((resolve) => {
      this.reachedResolve = resolve;
    });
  }

  hit(point: FaultPoint): Promise<void> {
    if (point !== this.point) {
      return Promise.resolve();
    }
    this.reachedResolve();

    return this.released;
  }

  open(): void {
    this.release();
  }
}
