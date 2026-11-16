import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { uuid } from '../../support/builders';
import { startTestApi, type TestApi } from '../../support/http';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
}, 180_000);

afterAll(async () => {
  docker('unpause');
  await api.stop();
});

function docker(action: 'pause' | 'unpause'): void {
  Bun.spawnSync(['docker', action, api.pg.container.getId()]);
}

describe('PostgreSQL unresponsive', () => {
  test('a write answers 503 with Retry-After within 20 s, readiness reports down, and both recover', async () => {
    const created = await api.request('POST', '/wallets', {
      body: { playerId: uuid(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    const wallet = created.json as { id: string; playerId: string };
    const token = await api.providerToken('provider-a');
    const body = {
      providerId: 'provider-a',
      externalTransactionId: `paused-${uuid()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const send = () =>
      api.request('POST', '/wagering/transactions', {
        token,
        body,
        headers: { 'idempotency-key': `provider-a:${body.externalTransactionId}` },
      });

    docker('pause');
    const startedAt = performance.now();
    const [res, ready] = await Promise.all([
      send(),
      api.request('GET', '/health/ready', { token: null }),
    ]);
    const elapsedMs = performance.now() - startedAt;

    docker('unpause');
    expect(res.status).toBe(503);
    expect(res.json['code']).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers.get('retry-after')).toBe('1');
    expect(elapsedMs).toBeLessThan(20_000);
    expect(ready.status).toBe(503);
    expect(ready.json['checks']).toMatchObject({ database: 'down', sqs: 'up' });

    const retried = await send();

    expect(retried.status).toBe(200);
    expect(retried.json['balance']).toEqual({ amount: '90.00', currency: 'BRL' });
  }, 60_000);
});
