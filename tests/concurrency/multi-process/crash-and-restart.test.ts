import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { uuid } from '../../support/builders';
import { ALL_ROLES, startCluster, httpBody, wagerData, type Cluster } from '../../support/cluster';
import { repeated } from '../../support/harness';
import { assertAllWalletsInvariants } from '../../support/invariants';
import { createTestQueues } from '../../support/sqs';
import { waitUntil } from '../../support/wait-until';
import type { AppProcess } from '../../support/app-process';

let c: Cluster;

beforeAll(async () => {
  c = await startCluster();
}, 240_000);

afterAll(async () => {
  await c.stop();
});

async function count(table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const { rows } = await c.db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );

  return rows[0]?.n ?? 0;
}

describe('README scenario 5 — a worker killed after commit and before ack', () => {
  for (const [index, name] of repeated(
    'the message returns to another instance and the inbox prevents a second effect',
  ).entries()) {
    test(
      name,
      async () => {
        const queues = await createTestQueues(c.sqs.endpoint, { prefix: `crash-${index}-` });
        const operatorApp = await c.spawn(`operator-${index}`, { roles: 'api', queues });
        const wallet = await c.openWallet('100.00', operatorApp);
        const faulty = await c.spawn(`faulty-${index}`, {
          roles: 'api,sqs-consumer',
          queues,
          env: { FAULT_INJECTION: 'after-commit-before-ack', SQS_VISIBILITY_TIMEOUT_SECONDS: '2' },
        });
        const messageId = await c.sendMessage(wagerData(wallet), { queueUrl: queues.wagerUrl });

        await faulty.exited;
        expect(faulty.process.signalCode).toBe('SIGKILL');
        expect(
          await count('inbox_messages', 'message_id = $1 AND processed_at IS NOT NULL', [
            messageId,
          ]),
        ).toBe(1);
        const healthy = await c.spawn(`healthy-${index}`, { roles: 'api,sqs-consumer', queues });

        await waitUntil(
          async () =>
            (await count('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [
              wallet.id,
            ])) === 1 && (await queueDrained(queues.wagerUrl)),
          { timeoutMs: 30_000, intervalMs: 200 },
        );

        expect(
          await count('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [
            wallet.id,
          ]),
        ).toBe(1);
        expect(
          await count('wager_transactions', "wallet_id = $1 AND kind = 'BET'", [wallet.id]),
        ).toBe(1);
        for (const app of [operatorApp, healthy]) {
          app.kill('SIGTERM');
          await app.exited;
        }
        await assertAllWalletsInvariants(c.db);
      },
      90_000,
    );
  }
});

async function queueDrained(url: string): Promise<boolean> {
  const { Attributes } = await c.sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );

  return (
    Attributes?.ApproximateNumberOfMessages === '0' &&
    Attributes.ApproximateNumberOfMessagesNotVisible === '0'
  );
}

describe('README scenario 8 — kill -9 of all instances in the middle of a load, then restart', () => {
  test('the whole load completes after the restart, balances match the ledger and no event stays unpublished', async () => {
    const first: AppProcess[] = [];

    for (const name of ['r-app-1', 'r-app-2', 'r-app-3']) {
      first.push(await c.spawn(name, { roles: ALL_ROLES }));
    }
    const wallets = await Promise.all(
      Array.from({ length: 20 }, () => c.openWallet('1000.00', first[0])),
    );
    const ids = wallets.map((wallet) => wallet.id);
    const commands = Array.from({ length: 300 }, (_, i) =>
      wagerData(wallets[i % wallets.length] as { id: string; playerId: string }, {
        money: { amount: '1.00', currency: 'BRL' },
      }),
    );
    const httpCommands = Array.from({ length: 60 }, (_, i) =>
      wagerData(wallets[i % wallets.length] as { id: string; playerId: string }, {
        kind: 'LOSS',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    );

    for (let i = 0; i < commands.length; i += 25) {
      await Promise.all(commands.slice(i, i + 25).map((data) => c.sendMessage(data)));
    }
    const inFlightHttp = httpCommands.map((data, i) =>
      c
        .request(first[i % 3] as AppProcess, 'POST', '/wagering/transactions', {
          token: c.providerToken,
          body: httpBody(data),
          headers: { 'idempotency-key': String(data['idempotencyKey']) },
        })
        .catch(() => ({ status: 0, json: {} })),
    );

    await waitUntil(
      async () =>
        (await count('wager_transactions', "kind = 'BET' AND wallet_id = ANY($1)", [ids])) >= 30,
      {
        timeoutMs: 30_000,
        intervalMs: 20,
      },
    );
    for (const app of first) {
      app.kill('SIGKILL');
    }
    await Promise.all(first.map((app) => app.exited));
    const doneBeforeCrash = await count(
      'wager_transactions',
      "kind = 'BET' AND wallet_id = ANY($1)",
      [ids],
    );

    expect(doneBeforeCrash).toBeLessThan(300);
    await Promise.all(inFlightHttp);
    const restarted: AppProcess[] = [];

    for (const name of ['r2-app-1', 'r2-app-2', 'r2-app-3']) {
      restarted.push(await c.spawn(name, { roles: ALL_ROLES }));
    }
    for (const [i, data] of httpCommands.entries()) {
      const res = await c.request(
        restarted[i % 3] as AppProcess,
        'POST',
        '/wagering/transactions',
        {
          token: c.providerToken,
          body: httpBody(data),
          headers: { 'idempotency-key': String(data['idempotencyKey']) },
        },
      );

      expect(res.status).toBe(200);
    }
    await waitUntil(
      async () =>
        (await count('wager_transactions', "kind = 'BET' AND wallet_id = ANY($1)", [ids])) ===
          300 && (await count('outbox_messages', 'published_at IS NULL')) === 0,
      { timeoutMs: 120_000, intervalMs: 500 },
    );

    expect(
      await count('wallet_ledger_entries', "direction = 'DEBIT' AND wallet_id = ANY($1)", [ids]),
    ).toBe(300);
    expect(await count('wager_transactions', "kind = 'LOSS' AND wallet_id = ANY($1)", [ids])).toBe(
      60,
    );
    await assertAllWalletsInvariants(c.db);
    for (const app of restarted) {
      app.kill('SIGTERM');
    }
    await Promise.all(restarted.map((app) => app.exited));
  }, 240_000);
});

describe('SIGTERM with an HTTP request in flight', () => {
  test('the request gets its correct answer and the process exits 0 within 30 s', async () => {
    const target = await c.spawn('sigterm-app', { roles: ALL_ROLES });
    const wallet = await c.openWallet('100.00', target);
    const holder = new Client({ connectionString: c.pg.migratorUrl });

    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
    const data = wagerData(wallet, { externalTransactionId: `sigterm-${uuid()}` });
    const inFlight = c.request(target, 'POST', '/wagering/transactions', {
      token: c.providerToken,
      body: httpBody(data),
      headers: { 'idempotency-key': String(data['idempotencyKey']) },
    });

    const admin = new Client({ connectionString: c.pg.superuserUrl });

    await admin.connect();
    await waitUntil(
      async () => {
        const { rows } = await admin.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE usename = 'app' AND wait_event_type = 'Lock'",
        );

        return (rows[0]?.n ?? 0) >= 1;
      },
      { timeoutMs: 5000, intervalMs: 20 },
    );
    await admin.end();
    const signalledAt = Date.now();

    target.kill('SIGTERM');
    await waitUntil(
      async () => {
        try {
          return (await fetch(`${target.baseUrl}/health/ready`)).status === 503;
        } catch {
          return false;
        }
      },
      { timeoutMs: 5000, intervalMs: 20 },
    );
    const lateRequest = await c.request(target, 'GET', `/wallets/${wallet.id}`);

    await holder.query('ROLLBACK');
    await holder.end();
    const response = await inFlight;
    const exitCode = await target.exited;

    expect(lateRequest.status).toBe(200);

    expect(response.status).toBe(200);
    expect(response.json['status']).toBe('PROCESSED');
    expect(exitCode).toBe(0);
    expect(Date.now() - signalledAt).toBeLessThan(30_000);
    await assertAllWalletsInvariants(c.db);
  }, 60_000);
});
