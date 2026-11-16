// Internal metrics endpoint on its own port, separate from the public API.
import type { PrometheusMetrics } from './prometheus-metrics';

export class MetricsServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    private readonly metrics: PrometheusMetrics,
    private readonly listenPort: number,
  ) {}

  start(): void {
    this.server = Bun.serve({
      port: this.listenPort,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== '/metrics') {
          return new Response('Not Found', { status: 404 });
        }

        return new Response(await this.metrics.scrape(), {
          headers: { 'content-type': this.metrics.registry.contentType },
        });
      },
    });
  }

  port(): number {
    return this.server?.port ?? this.listenPort;
  }

  stop(): void {
    void this.server?.stop(true);
    this.server = null;
  }
}
