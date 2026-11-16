// Metrics port with the closed set of metric names from design §11; metrics never carry money.
export type CounterName =
  | 'wager_transactions_total'
  | 'idempotent_replays_total'
  | 'inbox_duplicates_total'
  | 'inbox_payload_conflict_total'
  | 'processing_retries_total'
  | 'dlq_messages_total'
  | 'lock_conflicts_total'
  | 'db_deadlocks_total'
  | 'reconciliation_divergence_total'
  | 'outbox_publish_retries_total'
  | 'jwks_fetch_failures_total';

export type HistogramName =
  | 'processing_duration_seconds'
  | 'wallet_lock_wait_seconds'
  | 'db_transaction_duration_seconds'
  | 'outbox_publish_duration_seconds';

export type GaugeName = 'outbox_lag_seconds' | 'dlq_depth';

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricsPort {
  increment(name: CounterName, labels?: MetricLabels, value?: number): void;
  observe(name: HistogramName, value: number, labels?: MetricLabels): void;
  set(name: GaugeName, value: number, labels?: MetricLabels): void;
}

export class NoopMetrics implements MetricsPort {
  increment(): void {}

  observe(): void {}

  set(): void {}
}
