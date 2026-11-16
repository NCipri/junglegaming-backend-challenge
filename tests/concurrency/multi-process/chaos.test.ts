import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { uuid } from '../../support/builders';
import { startCluster, httpBody, wagerData, type Cluster } from '../../support/cluster';
import { assertAllWalletsInvariants } from '../../support/invariants';
import { waitUntil } from '../../support/wait-until';
import type { AppProcess } from '../../support/app-process';

let c: Cluster;
let apps: AppProcess[];

beforeAll(async () => {
  c = await startCluster();
  apps = [await c.spawn('chaos-1'), await c.spawn('chaos-2'), await c.spawn('chaos-3')];
}, 240_000);

afterAll(async () => {
  await c.stop();
});

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await c.db.query<{ n: string }>(sql, params);

  return Number.parseInt(rows[0]?.n ?? '0', 10);
}

async function queueDrained(): Promise<boolean> {
  const { Attributes } = await c.sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: c.queues.wagerUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );

  return (
    Attributes?.ApproximateNumberOfMessages === '0' &&
    Attributes.ApproximateNumberOfMessagesNotVisible === '0'
  );
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }

  return copy;
}

describe('chaos across 3 instances', () => {
  test('BET/WIN/LOSS/REFUND/ROLLBACK with duplicates and out-of-order reversals over HTTP and SQS: no deadlock, every ledger consistent, nothing pending', async () => {
    const deadlocksBefore = await scalar(
      'SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()',
    );
    const wallets = await Promise.all(Array.from({ length: 15 }, () => c.openWallet('1000.00')));
    const ids = wallets.map((wallet) => wallet.id);
    const commands = wallets
      .flatMap((wallet) =>
        Array.from({ length: 6 }, (_, round) => {
          const roundId = `round-${round}`;
          const bet = wagerData(wallet, { roundId, money: { amount: '10.00', currency: 'BRL' } });
          const betRef = String(bet['externalTransactionId']);
          const settle =
            round % 3 === 0
              ? wagerData(wallet, {
                  roundId,
                  kind: 'WIN',
                  money: { amount: '25.00', currency: 'BRL' },
                  referenceExternalTransactionId: betRef,
                })
              : round % 3 === 1
                ? wagerData(wallet, {
                    roundId,
                    kind: 'LOSS',
                    money: { amount: '0.00', currency: 'BRL' },
                    referenceExternalTransactionId: betRef,
                  })
                : wagerData(wallet, {
                    roundId,
                    kind: 'REFUND',
                    money: { amount: '10.00', currency: 'BRL' },
                    referenceExternalTransactionId: betRef,
                  });
          const undo = wagerData(wallet, {
            roundId,
            kind: 'ROLLBACK',
            money: settle['money'],
            referenceExternalTransactionId: settle['externalTransactionId'],
          });

          return round % 2 === 0 ? [bet, settle, undo] : [undo, settle, bet];
        }),
      )
      .flat();
    const deliveries = shuffled([...commands, ...commands.slice(0, 60)]);

    await Promise.all(
      deliveries.map(async (data, i) => {
        if (i % 2 === 0) {
          await c.sendMessage(data, { messageId: uuid() });

          return;
        }
        await c.request(apps[i % 3] as AppProcess, 'POST', '/wagering/transactions', {
          token: c.providerToken,
          body: httpBody(data),
          headers: { 'idempotency-key': String(data['idempotencyKey']) },
        });
      }),
    );
    await waitUntil(
      async () =>
        (await scalar(
          "SELECT COUNT(*)::text AS n FROM wager_transactions WHERE kind <> 'OPENING' AND wallet_id = ANY($1)",
          [ids],
        )) === commands.length &&
        (await scalar(
          "SELECT COUNT(*)::text AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND wallet_id = ANY($1)",
          [ids],
        )) === 0 &&
        (await queueDrained()),
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    await waitUntil(
      async () =>
        (await scalar(
          'SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL',
        )) === 0,
      {
        timeoutMs: 60_000,
        intervalMs: 500,
      },
    );

    expect(
      await scalar(
        'SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()',
      ),
    ).toBe(deadlocksBefore);
    expect(
      await scalar(
        "SELECT COUNT(*)::text AS n FROM wager_transactions WHERE status = 'FAILED' AND wallet_id = ANY($1)",
        [ids],
      ),
    ).toBe(0);
    expect(
      await scalar(
        `SELECT COUNT(*)::text AS n FROM (
           SELECT reference_transaction_id FROM wager_transactions
            WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND wallet_id = ANY($1)
            GROUP BY reference_transaction_id HAVING COUNT(*) > 1) d`,
        [ids],
      ),
    ).toBe(0);
    await assertAllWalletsInvariants(c.db);
  }, 300_000);
});
