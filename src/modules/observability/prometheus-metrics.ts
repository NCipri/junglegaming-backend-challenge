// Prometheus implementation of the metrics port: every metric of the closed list is registered up front.
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type {
  CounterName,
  GaugeName,
  HistogramName,
  MetricLabels,
  MetricsPort,
} from './metrics.port';

const COUNTERS: Record<CounterName, { help: string; labels: string[] }> = {
  wager_transactions_total: {
    help: 'Wager transactions by final status and kind',
    labels: ['status', 'kind'],
  },
  idempotent_replays_total: { help: 'Idempotent replays served', labels: ['channel'] },
  idempotency_conflicts_total: {
    help: 'Same idempotency key with a different payload',
    labels: ['channel'],
  },
  inbox_duplicates_total: { help: 'SQS messages already present in the inbox', labels: [] },
  inbox_payload_conflict_total: { help: 'Same messageId with a different payload', labels: [] },
  processing_retries_total: { help: 'Retries of transactional work by reason', labels: ['reason'] },
  dlq_messages_total: { help: 'Messages sent to the DLQ by reason', labels: ['reason'] },
  lock_conflicts_total: { help: 'Lock timeouts and version conflicts', labels: [] },
  db_deadlocks_total: { help: 'Deadlocks detected by PostgreSQL', labels: [] },
  reconciliation_divergence_total: { help: 'Reconciliations that found a divergence', labels: [] },
  outbox_publish_retries_total: {
    help: 'Outbox publications rescheduled after a failure',
    labels: [],
  },
  jwks_fetch_failures_total: { help: 'Failures fetching the identity provider keys', labels: [] },
};

const HISTOGRAMS: Record<HistogramName, { help: string; labels: string[] }> = {
  processing_duration_seconds: { help: 'End-to-end wager processing latency', labels: ['channel'] },
  wallet_lock_wait_seconds: { help: 'Time waiting for the wallet row lock', labels: [] },
  db_transaction_duration_seconds: {
    help: 'Duration of each database transaction attempt',
    labels: ['outcome'],
  },
  outbox_publish_duration_seconds: { help: 'Duration of each SQS publication', labels: [] },
};

const GAUGES: Record<GaugeName, { help: string; labels: string[] }> = {
  outbox_lag_seconds: { help: 'Age of the oldest unpublished outbox event', labels: [] },
  dlq_depth: { help: 'Messages waiting in the wager DLQ', labels: [] },
};

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class PrometheusMetrics implements MetricsPort {
  readonly registry = new Registry();
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, Gauge>();

  constructor() {
    for (const [name, def] of Object.entries(COUNTERS)) {
      this.counters.set(
        name,
        new Counter({ name, help: def.help, labelNames: def.labels, registers: [this.registry] }),
      );
    }
    for (const [name, def] of Object.entries(HISTOGRAMS)) {
      this.histograms.set(
        name,
        new Histogram({
          name,
          help: def.help,
          labelNames: def.labels,
          buckets: BUCKETS,
          registers: [this.registry],
        }),
      );
    }
    for (const [name, def] of Object.entries(GAUGES)) {
      this.gauges.set(
        name,
        new Gauge({ name, help: def.help, labelNames: def.labels, registers: [this.registry] }),
      );
    }
  }

  increment(name: CounterName, labels: MetricLabels = {}, value = 1): void {
    this.counters.get(name)?.inc({ ...labels }, value);
  }

  observe(name: HistogramName, value: number, labels: MetricLabels = {}): void {
    this.histograms.get(name)?.observe({ ...labels }, value);
  }

  set(name: GaugeName, value: number, labels: MetricLabels = {}): void {
    this.gauges.get(name)?.set({ ...labels }, value);
  }

  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
