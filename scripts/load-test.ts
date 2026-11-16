import { availableParallelism, cpus, totalmem } from 'node:os';

const BASE_URL = process.env.LOAD_BASE_URL ?? 'http://localhost:8080';
const AUTH_ISSUER = process.env.AUTH_ISSUER ?? 'http://localhost:8081/realms/wagering';
const PROMETHEUS_URL = process.env.LOAD_PROMETHEUS_URL ?? 'http://localhost:9090';
const DURATION_S = Number.parseInt(process.env.LOAD_DURATION_S ?? '60', 10);
const CONCURRENCY = Number.parseInt(process.env.LOAD_CONCURRENCY ?? '32', 10);
const WALLETS = Number.parseInt(process.env.LOAD_WALLETS ?? '200', 10);
const HOT_SHARE = Number.parseFloat(process.env.LOAD_HOT_SHARE ?? '0.2');
const REPLAY_SHARE = Number.parseFloat(process.env.LOAD_REPLAY_SHARE ?? '0.1');

interface Wallet {
  id: string;
  playerId: string;
}

interface Sample {
  ms: number;
  status: number;
  replay: boolean;
}

async function token(clientId: string): Promise<string> {
  const response = await fetch(`${AUTH_ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: `${clientId}-secret`,
    }),
  });

  if (!response.ok) {
    throw new Error(`token for ${clientId}: ${response.status}`);
  }

  return ((await response.json()) as { access_token: string }).access_token;
}

async function prometheus(query: string): Promise<number | null> {
  try {
    const response = await fetch(
      `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`,
    );
    const body = (await response.json()) as { data: { result: { value: [number, string] }[] } };
    const value = body.data.result[0]?.value[1];

    return value === undefined || value === 'NaN' ? null : Number.parseFloat(value);
  } catch {
    return null;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function round(value: number | null, digits = 2): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

async function openWallets(operator: string): Promise<Wallet[]> {
  const wallets: Wallet[] = [];

  for (let i = 0; i < WALLETS; i++) {
    const playerId = Bun.randomUUIDv7();
    const response = await fetch(`${BASE_URL}/wallets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100000.00', currency: 'BRL' } }),
    });

    if (response.status !== 201) {
      throw new Error(`wallet creation failed: ${response.status}`);
    }
    wallets.push({ id: ((await response.json()) as { id: string }).id, playerId });
  }

  return wallets;
}

async function run(): Promise<void> {
  const [operator, provider] = await Promise.all([token('backoffice'), token('provider-a')]);
  const wallets = await openWallets(operator);
  const hot = wallets[0] as Wallet;
  const before = {
    lockConflicts: (await prometheus('sum(lock_conflicts_total)')) ?? 0,
    deadlocks: (await prometheus('sum(db_deadlocks_total)')) ?? 0,
    retries: (await prometheus('sum(processing_retries_total)')) ?? 0,
  };
  const samples: Sample[] = [];
  const sent: { key: string; body: string }[] = [];
  let maxOutboxLag = 0;
  const deadline = performance.now() + DURATION_S * 1000;
  const lagProbe = setInterval(() => {
    void prometheus('max(outbox_lag_seconds)').then((lag) => {
      maxOutboxLag = Math.max(maxOutboxLag, lag ?? 0);
    });
  }, 1000);
  let sequence = 0;
  const worker = async () => {
    while (performance.now() < deadline) {
      const isReplay = sent.length > 0 && Math.random() < REPLAY_SHARE;
      let key: string;
      let body: string;

      if (isReplay) {
        const previous = sent[Math.floor(Math.random() * sent.length)] as {
          key: string;
          body: string;
        };

        key = previous.key;
        body = previous.body;
      } else {
        sequence += 1;
        const wallet =
          Math.random() < HOT_SHARE
            ? hot
            : (wallets[Math.floor(Math.random() * wallets.length)] as Wallet);
        const externalTransactionId = `load-${Date.now()}-${sequence}`;

        key = `provider-a:${externalTransactionId}`;
        body = JSON.stringify({
          providerId: 'provider-a',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `round-${sequence}`,
          gameId: 'load-game',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        });
        sent.push({ key, body });
      }
      const startedAt = performance.now();
      let status: number;

      try {
        const response = await fetch(`${BASE_URL}/wagering/transactions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${provider}`,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body,
        });

        status = response.status;
        await response.arrayBuffer();
      } catch {
        status = 0;
      }
      samples.push({ ms: performance.now() - startedAt, status, replay: isReplay });
    }
  };
  const startedAt = performance.now();

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedS = (performance.now() - startedAt) / 1000;
  const drainStartedAt = performance.now();
  let drained = false;

  while (performance.now() - drainStartedAt < 60_000) {
    const pending = await prometheus('max(outbox_lag_seconds)');

    if (pending === 0) {
      drained = true;
      break;
    }
    await Bun.sleep(500);
  }
  const drainS = (performance.now() - drainStartedAt) / 1000;

  clearInterval(lagProbe);
  let consistent = 0;
  let inconsistent = 0;

  for (const wallet of wallets) {
    const response = await fetch(`${BASE_URL}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
      headers: { authorization: `Bearer ${operator}` },
    });
    const report = (await response.json()) as { consistent?: boolean };

    if (report.consistent === true) {
      consistent += 1;
    } else {
      inconsistent += 1;
    }
  }
  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const byStatus = new Map<number, number>();

  for (const sample of samples) {
    byStatus.set(sample.status, (byStatus.get(sample.status) ?? 0) + 1);
  }
  const ok = samples.filter((sample) => sample.status === 200).length;
  const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;
  const after = {
    lockConflicts: (await prometheus('sum(lock_conflicts_total)')) ?? 0,
    deadlocks: (await prometheus('sum(db_deadlocks_total)')) ?? 0,
    retries: (await prometheus('sum(processing_retries_total)')) ?? 0,
  };
  const cpu = cpus()[0]?.model ?? 'unknown';
  const lines = [
    '## Load test result',
    '',
    `- Environment: ${cpu} · ${availableParallelism()} logical CPUs · ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM · Bun ${Bun.version} · whole stack (3 app instances, nginx, PostgreSQL, MiniStack, Keycloak) on this one machine via Docker Compose`,
    `- Workload: ${DURATION_S} s, ${CONCURRENCY} concurrent HTTP clients through nginx, ${WALLETS} wallets, ${(HOT_SHARE * 100).toFixed(0)}% of new bets on one hot wallet, ${(REPLAY_SHARE * 100).toFixed(0)}% of requests are idempotent replays; each request is a BET of 1.00`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Requests | ${samples.length} in ${elapsedS.toFixed(1)} s |`,
    `| Throughput | ${(samples.length / elapsedS).toFixed(1)} req/s (${(ok / elapsedS).toFixed(1)} answered 200/s) |`,
    `| Latency p50 / p95 / p99 / max | ${round(percentile(latencies, 50), 1)} / ${round(percentile(latencies, 95), 1)} / ${round(percentile(latencies, 99), 1)} / ${round(latencies.at(-1) ?? 0, 1)} ms |`,
    `| Status codes | ${[...byStatus.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([status, count]) => `${status}: ${count}`)
      .join(', ')} |`,
    `| Error rate (5xx or no response) | ${((errors / Math.max(1, samples.length)) * 100).toFixed(2)}% |`,
    `| Replays sent | ${samples.filter((sample) => sample.replay).length} |`,
    `| Lock conflicts / deadlocks / retries during the run | ${after.lockConflicts - before.lockConflicts} / ${after.deadlocks - before.deadlocks} / ${after.retries - before.retries} |`,
    `| Outbox lag (max during the run) | ${round(maxOutboxLag)} s |`,
    `| Outbox fully drained after the run | ${drained ? `yes, in ${drainS.toFixed(1)} s` : 'no (within 60 s)'} |`,
    `| Reconciliation of every wallet | ${consistent} consistent, ${inconsistent} inconsistent |`,
  ];

  console.log(lines.join('\n'));
  if (inconsistent > 0) {
    process.exit(1);
  }
}

await run();
