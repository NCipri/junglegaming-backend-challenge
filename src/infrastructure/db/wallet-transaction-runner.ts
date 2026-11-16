// The single entry point for transactional work (D-030): server timeouts, retries by error class and cancellation.
import type { EntityManager } from '@mikro-orm/postgresql';
import type { MetricsPort } from '../../modules/observability/metrics.port';
import { computeBackoff } from '../../shared/time/backoff';
import { classifyError, type ErrorClass } from './error-classification';
import { TransientPersistenceError } from './persistence.errors';
import { createTxContext, type TxContext } from './tx-context';
import type { RunOptions, RunnerSettings } from './wallet-transaction-runner.types';

export type { RunOptions, RunnerSettings } from './wallet-transaction-runner.types';

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_UNIQUE_REEXECUTIONS = 2;
const DEFAULT_RETRY_BASE_MS = 25;
const DEFAULT_RETRY_CAP_MS = 1000;

function millis(value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid timeout: ${value}`);
  }

  return `${value}ms`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Transaction aborted');
}

export class WalletTransactionRunner {
  private readonly sessionSql: string;

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort,
    private readonly settings: RunnerSettings,
  ) {
    this.sessionSql =
      `SELECT set_config('lock_timeout', '${millis(settings.lockTimeoutMs)}', true), ` +
      `set_config('statement_timeout', '${millis(settings.statementTimeoutMs)}', true), ` +
      `set_config('idle_in_transaction_session_timeout', '${millis(settings.idleInTxTimeoutMs)}', true)`;
  }

  async run<T>(work: (tx: TxContext) => Promise<T>, opts: RunOptions = {}): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    let transientFailures = 0;
    let uniqueReexecutions = 0;

    for (;;) {
      if (opts.signal?.aborted) {
        throw abortReason(opts.signal);
      }
      const startedAt = performance.now();

      try {
        const result = await this.attempt(work, opts.signal);

        this.recordDuration(startedAt, 'commit');

        return result;
      } catch (error) {
        this.recordDuration(startedAt, 'rollback');
        if (opts.signal?.aborted) {
          throw error;
        }
        const errorClass = classifyError(error);

        this.recordFailure(errorClass);
        if (errorClass.kind === 'DETERMINISTIC') {
          throw error;
        }
        if (errorClass.kind === 'UNIQUE_VIOLATION') {
          if (uniqueReexecutions >= MAX_UNIQUE_REEXECUTIONS) {
            throw new TransientPersistenceError('UNIQUE_RETRIES_EXHAUSTED', error);
          }
          uniqueReexecutions += 1;
          this.metrics.increment('processing_retries_total', { reason: 'UNIQUE_VIOLATION' });
          continue;
        }
        transientFailures += 1;
        if (transientFailures >= maxAttempts) {
          throw new TransientPersistenceError(errorClass.reason, error);
        }
        this.metrics.increment('processing_retries_total', { reason: errorClass.reason });
        await this.pause(transientFailures - 1);
      }
    }
  }

  private attempt<T>(work: (tx: TxContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.em.fork().transactional(
      async (em) => {
        await em.execute(this.sessionSql);

        return work(createTxContext(em, this.metrics));
      },
      signal ? { signal, inflightQueryAbortStrategy: 'kill session' } : {},
    );
  }

  private recordFailure(errorClass: ErrorClass): void {
    if (errorClass.kind !== 'TRANSIENT') {
      return;
    }
    if (errorClass.reason === 'DEADLOCK') {
      this.metrics.increment('db_deadlocks_total');
    }
    if (
      errorClass.reason === 'LOCK_TIMEOUT' ||
      errorClass.reason === 'VERSION_CONFLICT' ||
      errorClass.reason === 'LEDGER_VERSION_CONFLICT'
    ) {
      this.metrics.increment('lock_conflicts_total');
    }
  }

  private recordDuration(startedAt: number, outcome: 'commit' | 'rollback'): void {
    this.metrics.observe(
      'db_transaction_duration_seconds',
      (performance.now() - startedAt) / 1000,
      {
        outcome,
      },
    );
  }

  private pause(attempts: number): Promise<void> {
    const delayMs = computeBackoff({
      attempts,
      baseMs: this.settings.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      capMs: this.settings.retryCapMs ?? DEFAULT_RETRY_CAP_MS,
      random: this.settings.random ?? Math.random,
    });

    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
