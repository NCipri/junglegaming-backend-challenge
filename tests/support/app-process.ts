import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Subprocess } from 'bun';

const ROOT = resolve(import.meta.dir, '../..');
const LOG_DIR = resolve(ROOT, 'coverage/app-logs');

export interface AppProcess {
  name: string;
  baseUrl: string;
  process: Subprocess;
  exited: Promise<number>;
  waitReady(timeoutMs?: number): Promise<void>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;

  void probe.stop(true);
  if (port === undefined) {
    throw new Error('no free port available');
  }

  return port;
}

export function spawnApp(p: {
  name: string;
  roles: string;
  env: Record<string, string>;
}): AppProcess {
  mkdirSync(LOG_DIR, { recursive: true });
  const httpPort = freePort();
  const metricsPort = freePort();
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...p.env,
      APP_ROLES: p.roles,
      INSTANCE_ID: p.name,
      HTTP_PORT: String(httpPort),
      METRICS_PORT: String(metricsPort),
      LOG_LEVEL: p.env['LOG_LEVEL'] ?? 'warn',
    },
    stdout: Bun.file(resolve(LOG_DIR, `${p.name}-${httpPort}.log`)),
    stderr: Bun.file(resolve(LOG_DIR, `${p.name}-${httpPort}.err.log`)),
  });
  const baseUrl = `http://127.0.0.1:${httpPort}`;

  return {
    name: p.name,
    baseUrl,
    process: child,
    exited: child.exited,
    waitReady: async (timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`${p.name} exited with ${child.exitCode}`);
        }
        try {
          if ((await fetch(`${baseUrl}/health/ready`)).status === 200) {
            return;
          }
        } catch {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`${p.name} not ready within ${timeoutMs} ms`);
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}
