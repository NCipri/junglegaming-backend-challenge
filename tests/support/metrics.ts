import type {
  CounterName,
  GaugeName,
  HistogramName,
  MetricLabels,
  MetricsPort,
} from '../../src/modules/observability/metrics.port';

function seriesKey(name: string, labels: MetricLabels = {}): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`);

  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
}

export class InMemoryMetrics implements MetricsPort {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly gauges = new Map<string, number>();

  increment(name: CounterName, labels?: MetricLabels, value = 1): void {
    const key = seriesKey(name, labels);

    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: HistogramName, value: number, labels?: MetricLabels): void {
    const key = seriesKey(name, labels);

    this.histograms.set(key, [...(this.histograms.get(key) ?? []), value]);
  }

  set(name: GaugeName, value: number, labels?: MetricLabels): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  counter(name: CounterName, labels?: MetricLabels): number {
    return this.counters.get(seriesKey(name, labels)) ?? 0;
  }

  observations(name: HistogramName, labels?: MetricLabels): number[] {
    return this.histograms.get(seriesKey(name, labels)) ?? [];
  }

  allObservations(name: HistogramName): number[] {
    return [...this.histograms.entries()]
      .filter(([key]) => key === name || key.startsWith(`${name}{`))
      .flatMap(([, values]) => values);
  }

  gauge(name: GaugeName, labels?: MetricLabels): number | undefined {
    return this.gauges.get(seriesKey(name, labels));
  }
}
