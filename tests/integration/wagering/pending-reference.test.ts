import { describe, expect, test } from 'bun:test';
import { FakeClock } from '../../support/clock';
import { useCaseHarness } from '../../support/harness';
import { createUseCases, wagerCommand, type UseCases } from '../../support/use-cases';
import { waitUntil } from '../../support/wait-until';
import { WagerKind } from '../../../src/modules/wagering/domain/wager-kind';

const h = useCaseHarness();
const HTTP = { type: 'HTTP' } as const;

async function statusOf(
  app: UseCases,
  providerId: string,
  externalId: string,
): Promise<string | undefined> {
  return (await app.getTransaction.byExternalId(providerId, externalId, { role: 'operator' }))
    ?.status;
}

async function eventTypes(): Promise<string[]> {
  const { rows } = await h.db.query<{ event_type: string }>(
    'SELECT event_type FROM outbox_messages ORDER BY occurred_at, id',
  );

  return rows.map((row) => row.event_type);
}

async function drain(app: UseCases, instanceId = 'worker-1'): Promise<void> {
  const worker = app.pendingWorker(instanceId);

  while ((await worker.tick()) > 0) {
    continue;
  }
}

describe('PendingReferenceWorker', () => {
  test('a ROLLBACK before its BET is accelerated by the BET and resolved within 2 s', async () => {
    const wallet = await h.openWallet('100.00');
    const bet = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const rollback = wagerCommand(wallet, {
      kind: WagerKind.Rollback,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const worker = h.app.pendingWorker('worker-1', { pollMs: 100 });

    await h.app.processWager.execute(rollback, HTTP);
    worker.start();
    try {
      await h.app.processWager.execute(bet, HTTP);
      const startedAt = Date.now();

      await waitUntil(
        async () =>
          (await statusOf(h.app, 'provider-a', rollback.externalTransactionId)) === 'PROCESSED',
        {
          timeoutMs: 2000,
        },
      );

      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      await worker.stop();
    }
    expect((await h.app.getWallet.execute(wallet.id))?.balance.amount).toBe('100.00');
    const types = await eventTypes();

    expect(types.indexOf('WagerTransactionPendingReference')).toBeGreaterThanOrEqual(0);
    expect(types.filter((type) => type === 'WalletBalanceChanged')).toHaveLength(3);
    expect(types.lastIndexOf('WagerTransactionProcessed')).toBeGreaterThan(
      types.indexOf('WagerTransactionPendingReference'),
    );
  });

  test('a REFUND whose BET never arrives is REJECTED REFERENCE_NOT_FOUND after the TTL, with its event', async () => {
    const clock = new FakeClock();
    const app = createUseCases(h.t, { pendingTtlMs: 2000, clock });
    const wallet = await h.openWallet('100.00');
    const refund = wagerCommand(wallet, {
      kind: WagerKind.Refund,
      referenceExternalTransactionId: 'never',
    });

    await app.processWager.execute(refund, HTTP);
    await drain(app);
    expect(await statusOf(app, 'provider-a', refund.externalTransactionId)).toBe(
      'PENDING_REFERENCE',
    );
    clock.advance(2100);
    await drain(app);

    expect(await statusOf(app, 'provider-a', refund.externalTransactionId)).toBe('REJECTED');
    const details = await app.getTransaction.byExternalId(
      'provider-a',
      refund.externalTransactionId,
      {
        role: 'operator',
      },
    );

    expect(details?.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await eventTypes()).toContain('WagerTransactionRejected');
  });

  test('a BET that arrives after the TTL but before the worker runs still resolves the pending one', async () => {
    const clock = new FakeClock();
    const app = createUseCases(h.t, { pendingTtlMs: 500, clock });
    const wallet = await h.openWallet('100.00');
    const bet = wagerCommand(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const refund = wagerCommand(wallet, {
      kind: WagerKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    await app.processWager.execute(refund, HTTP);
    clock.advance(600);
    await app.processWager.execute(bet, HTTP);
    await drain(app);

    expect(await statusOf(app, 'provider-a', refund.externalTransactionId)).toBe('PROCESSED');
    expect((await app.getWallet.execute(wallet.id))?.balance.amount).toBe('100.00');
  });

  test('a chain ROLLBACK(REFUND) → REFUND → BET resolves all three and ends at the post-BET balance', async () => {
    const wallet = await h.openWallet('100.00');
    const bet = wagerCommand(wallet, { money: { amount: '40.00', currency: 'BRL' } });
    const refund = wagerCommand(wallet, {
      kind: WagerKind.Refund,
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const undo = wagerCommand(wallet, {
      kind: WagerKind.Rollback,
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: refund.externalTransactionId,
    });

    await h.app.processWager.execute(undo, HTTP);
    await h.app.processWager.execute(refund, HTTP);
    await h.app.processWager.execute(bet, HTTP);
    await waitUntil(
      async () => {
        await drain(h.app);

        return (await statusOf(h.app, 'provider-a', undo.externalTransactionId)) === 'PROCESSED';
      },
      { timeoutMs: 5000, intervalMs: 50 },
    );

    expect(await statusOf(h.app, 'provider-a', refund.externalTransactionId)).toBe('PROCESSED');
    expect((await h.app.getWallet.execute(wallet.id))?.balance.amount).toBe('60.00');
  });

  test('two workers over 100 pending transactions resolve each exactly once, without deadlocks', async () => {
    const deadlocks = async () => {
      const { rows } = await h.db.query<{ deadlocks: string }>(
        'SELECT deadlocks::text FROM pg_stat_database WHERE datname = current_database()',
      );

      return Number.parseInt(rows[0]?.deadlocks ?? '0', 10);
    };
    const before = await deadlocks();
    const wallets = await Promise.all(Array.from({ length: 20 }, () => h.openWallet('100.00')));
    const pairs = wallets.flatMap((wallet) =>
      Array.from({ length: 5 }, () => {
        const bet = wagerCommand(wallet, { money: { amount: '1.00', currency: 'BRL' } });

        return {
          bet,
          refund: wagerCommand(wallet, {
            kind: WagerKind.Refund,
            money: { amount: '1.00', currency: 'BRL' },
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        };
      }),
    );

    for (const { refund } of pairs) {
      await h.app.processWager.execute(refund, HTTP);
    }
    for (const { bet } of pairs) {
      await h.app.processWager.execute(bet, HTTP);
    }
    await Promise.all([drain(h.app, 'worker-a'), drain(h.app, 'worker-b')]);
    await waitUntil(
      async () => {
        await drain(h.app);

        return (await h.count('wager_transactions', "status = 'PENDING_REFERENCE'")) === 0;
      },
      { timeoutMs: 10_000, intervalMs: 50 },
    );

    expect(await h.count('wager_transactions', "kind = 'REFUND' AND status = 'PROCESSED'")).toBe(
      100,
    );
    expect(await h.count('wallet_ledger_entries', 'TRUE')).toBe(20 + 200);
    for (const wallet of wallets) {
      expect((await h.app.getWallet.execute(wallet.id))?.balance.amount).toBe('100.00');
    }
    expect((await deadlocks()) - before).toBe(0);
  }, 60_000);

  test('a worker that dies after claiming is replaced by another once the lease expires', async () => {
    const wallet = await h.openWallet('100.00');
    const bet = wagerCommand(wallet, { money: { amount: '10.00', currency: 'BRL' } });
    const refund = wagerCommand(wallet, {
      kind: WagerKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    await h.app.processWager.execute(refund, HTTP);
    await h.app.processWager.execute(bet, HTTP);
    const claimed = await h.t.context().transactions.claimDuePending({
      instanceId: 'dead-worker',
      limit: 10,
      leaseMs: 1000,
      now: new Date(),
    });

    expect(claimed).toHaveLength(1);
    const survivor = h.app.pendingWorker('worker-2', { leaseMs: 1000 });

    expect(await survivor.tick()).toBe(0);
    await waitUntil(async () => (await survivor.tick()) > 0, { timeoutMs: 5000, intervalMs: 100 });

    expect(await statusOf(h.app, 'provider-a', refund.externalTransactionId)).toBe('PROCESSED');
  });
});
