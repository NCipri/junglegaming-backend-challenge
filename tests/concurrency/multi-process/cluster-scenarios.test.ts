import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { uuid, startGate } from '../../support/builders';
import { startCluster, httpBody, wagerData, type Cluster } from '../../support/cluster';
import { repeated } from '../../support/harness';
import { assertAllWalletsInvariants } from '../../support/invariants';
import { receiveAll } from '../../support/sqs';
import { waitUntil } from '../../support/wait-until';
import type { AppProcess } from '../../support/app-process';

let c: Cluster;
let apps: AppProcess[];

beforeAll(async () => {
  c = await startCluster();
  apps = [await c.spawn('app-1'), await c.spawn('app-2'), await c.spawn('app-3')];
}, 240_000);

afterAll(async () => {
  await c.stop();
});

const app = (i: number): AppProcess => apps[i % apps.length] as AppProcess;

async function count(table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const { rows } = await c.db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );

  return rows[0]?.n ?? 0;
}

async function deadlocks(): Promise<number> {
  const { rows } = await c.db.query<{ n: string }>(
    'SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()',
  );

  return Number.parseInt(rows[0]?.n ?? '0', 10);
}

async function balance(walletId: string): Promise<string> {
  const res = await c.request(app(0), 'GET', `/wallets/${walletId}`);

  return String((res.json['balance'] as { amount: string } | undefined)?.amount);
}

function submit(target: AppProcess, data: Record<string, unknown>) {
  return c.request(target, 'POST', '/wagering/transactions', {
    token: c.providerToken,
    body: httpBody(data),
    headers: { 'idempotency-key': String(data['idempotencyKey']) },
  });
}

async function queueEmpty(url: string): Promise<boolean> {
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

describe('README scenario 1 — the same BET 50 times across 3 instances, over HTTP and SQS', () => {
  for (const name of repeated('exactly one debit')) {
    test(
      name,
      async () => {
        const wallet = await c.openWallet('1000.00');
        const data = wagerData(wallet, { money: { amount: '25.00', currency: 'BRL' } });
        const gate = startGate();
        const viaHttp = Array.from({ length: 25 }, async (_, i) => {
          await gate.wait();

          return submit(app(i), data);
        });
        const viaSqs = Array.from({ length: 25 }, async () => {
          await gate.wait();

          return c.sendMessage(data);
        });

        gate.release();
        const responses = await Promise.all(viaHttp);
        const messageIds = await Promise.all(viaSqs);

        await waitUntil(
          async () =>
            (await count('inbox_messages', 'message_id = ANY($1) AND processed_at IS NOT NULL', [
              messageIds,
            ])) === 25,
          { timeoutMs: 30_000, intervalMs: 100 },
        );

        expect(responses.every((r) => r.status === 200)).toBe(true);
        expect(
          responses.filter((r) => r.json['idempotentReplay'] === false).length,
        ).toBeLessThanOrEqual(1);
        expect(
          await count('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [
            wallet.id,
          ]),
        ).toBe(1);
        expect(await balance(wallet.id)).toBe('975.00');
        await assertAllWalletsInvariants(c.db);
      },
      60_000,
    );
  }
});

describe('README scenario 2 — two BETs of 80 on a balance of 100, on different instances', () => {
  for (const name of repeated('one PROCESSED, one REJECTED, balance 20')) {
    test(
      name,
      async () => {
        const wallet = await c.openWallet('100.00');
        const gate = startGate();
        const runs = [0, 1].map(async (i) => {
          await gate.wait();

          return submit(app(i), wagerData(wallet, { money: { amount: '80.00', currency: 'BRL' } }));
        });

        gate.release();
        const statuses = (await Promise.all(runs))
          .map((r) => `${r.status}:${String(r.json['status'])}`)
          .sort();

        expect(statuses).toEqual(['200:PROCESSED', '422:REJECTED']);
        expect(await balance(wallet.id)).toBe('20.00');
        expect(
          await count('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [
            wallet.id,
          ]),
        ).toBe(1);
        await assertAllWalletsInvariants(c.db);
      },
      30_000,
    );
  }
});

describe('README scenario 3 — distinct wallets in parallel on the 3 instances', () => {
  test('10 wallets × 10 BETs spread over the instances keep every invariant', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => c.openWallet('100.00')));
    const gate = startGate();
    const runs = wallets.flatMap((wallet, w) =>
      Array.from({ length: 10 }, async (_, i) => {
        await gate.wait();

        return submit(
          app(w + i),
          wagerData(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
        );
      }),
    );

    gate.release();
    const results = await Promise.all(runs);

    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const wallet of wallets) {
      expect(await balance(wallet.id)).toBe('90.00');
    }
    await assertAllWalletsInvariants(c.db);
  }, 60_000);
});

describe('README scenarios 4 and 6 — 1,000 messages for 50 wallets on 3 consumers and 3 relays', () => {
  test('every command has one effect, no deadlock, and every event is published at least once', async () => {
    const deadlocksBefore = await deadlocks();
    const wallets = await Promise.all(Array.from({ length: 50 }, () => c.openWallet('1000.00')));
    const ids = wallets.map((wallet) => wallet.id);
    const kinds = ['BET', 'BET', 'WIN', 'LOSS'];
    const commands = Array.from({ length: 800 }, (_, i) => {
      const wallet = wallets[i % wallets.length] as { id: string; playerId: string };

      return {
        messageId: uuid(),
        data: wagerData(wallet, {
          kind: kinds[i % kinds.length],
          money: { amount: kinds[i % kinds.length] === 'WIN' ? '0.50' : '1.00', currency: 'BRL' },
        }),
      };
    });
    const duplicates = commands.slice(0, 200);
    const all = [
      ...commands,
      ...duplicates.map((d, i) => (i % 2 === 0 ? d : { ...d, messageId: uuid() })),
    ];

    for (let i = 0; i < all.length; i += 25) {
      await Promise.all(
        all.slice(i, i + 25).map((m) => c.sendMessage(m.data, { messageId: m.messageId })),
      );
    }
    await waitUntil(
      async () =>
        (await count('wager_transactions', "kind <> 'OPENING' AND wallet_id = ANY($1)", [ids])) ===
          800 && (await queueEmpty(c.queues.wagerUrl)),
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    await waitUntil(async () => (await count('outbox_messages', 'published_at IS NULL')) === 0, {
      timeoutMs: 60_000,
      intervalMs: 500,
    });

    expect(
      await count(
        'wager_transactions',
        "kind = 'BET' AND status = 'PROCESSED' AND wallet_id = ANY($1)",
        [ids],
      ),
    ).toBe(400);
    expect(
      await count('wallet_ledger_entries', "direction = 'DEBIT' AND wallet_id = ANY($1)", [ids]),
    ).toBe(400);
    expect((await deadlocks()) - deadlocksBefore).toBe(0);
    const outboxIds = new Set(
      (await c.db.query<{ id: string }>('SELECT id::text AS id FROM outbox_messages')).rows.map(
        (row) => row.id,
      ),
    );
    const received = await receiveAll(c.sqsClient, c.queues.eventsUrl, {
      waitMs: 120_000,
      expected: outboxIds.size,
    });
    const eventIds = new Set(
      received.map((m) => (JSON.parse(m.body) as { eventId: string }).eventId),
    );

    expect([...outboxIds].filter((id) => !eventIds.has(id))).toEqual([]);
    await assertAllWalletsInvariants(c.db);
  }, 300_000);
});

describe('README scenario 7 — a reversal before its reference, the reference on another instance', () => {
  test('the ROLLBACK waits as PENDING_REFERENCE and is resolved once the BET arrives elsewhere', async () => {
    const wallet = await c.openWallet('100.00');
    const bet = wagerData(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const rollback = wagerData(wallet, {
      kind: 'ROLLBACK',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet['externalTransactionId'],
    });

    expect((await submit(app(0), rollback)).status).toBe(202);
    expect((await submit(app(1), bet)).status).toBe(200);
    await waitUntil(
      async () => {
        const res = await c.request(
          app(2),
          'GET',
          `/providers/provider-a/wagering/transactions/${String(rollback['externalTransactionId'])}`,
          { token: c.providerToken },
        );

        return res.json['status'] === 'PROCESSED';
      },
      { timeoutMs: 15_000, intervalMs: 100 },
    );

    expect(await balance(wallet.id)).toBe('100.00');
    await assertAllWalletsInvariants(c.db);
  }, 30_000);
});

describe('correctness does not depend on FIFO', () => {
  test('a standard queue with duplicates and no ordering still yields one effect per command', async () => {
    const { QueueUrl: standardUrl } = await c.sqsClient.send(
      new CreateQueueCommand({ QueueName: 'standard-wager' }),
    );
    const consumer = await c.spawn('app-standard', {
      roles: 'api,sqs-consumer',
      queues: { ...c.queues, wagerUrl: String(standardUrl) },
    });
    const wallet = await c.openWallet('100.00');
    const commands = Array.from({ length: 30 }, () => ({
      messageId: uuid(),
      data: wagerData(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
    }));
    const sends = [...commands, ...commands, ...commands.map((m) => ({ ...m, messageId: uuid() }))];

    await Promise.all(
      sends.map((m) =>
        c.sendMessage(m.data, {
          messageId: m.messageId,
          queueUrl: String(standardUrl),
          fifo: false,
        }),
      ),
    );
    await waitUntil(
      async () => (await queueEmpty(String(standardUrl))) && (await balance(wallet.id)) === '70.00',
      {
        timeoutMs: 60_000,
        intervalMs: 300,
      },
    );
    consumer.kill('SIGTERM');
    await consumer.exited;

    expect(
      await count('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [wallet.id]),
    ).toBe(30);
    await assertAllWalletsInvariants(c.db);
  }, 90_000);
});
