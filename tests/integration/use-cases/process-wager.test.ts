import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { hashOf, uuid } from '../../support/builders';
import { assertAllWalletsInvariants } from '../../support/invariants';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import { createUseCases, wagerCommand, type UseCases } from '../../support/use-cases';
import type {
  WagerChannel,
  WagerCommand,
} from '../../../src/modules/wagering/application/wager-command';
import type { WagerResult } from '../../../src/modules/wagering/application/wager-result';
import { WagerKind } from '../../../src/modules/wagering/domain/wager-kind';
import { WagerStatus } from '../../../src/modules/wagering/domain/wager-status';

let pg: TestPostgres;
let db: Client;
let t: TestOrm;
let app: UseCases;

const HTTP: WagerChannel = { type: 'HTTP' };

beforeAll(async () => {
  pg = await startPostgres();
  await migrateUp(pg.migratorUrl);
  db = new Client({ connectionString: pg.migratorUrl });
  await db.connect();
  t = await createTestOrm(pg.appUrl);
  app = createUseCases(t);
}, 120_000);

afterAll(async () => {
  await t.close();
  await db.end();
  await pg.stop();
});

beforeEach(async () => {
  await resetDatabase(pg.migratorUrl);
});

afterEach(async () => {
  await assertAllWalletsInvariants(db);
});

async function openWallet(amount = '1000.00', playerId = uuid()) {
  const result = await app.openWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });

  if (result.type !== 'CREATED') {
    throw new Error('expected CREATED');
  }

  return result.wallet;
}

function sqs(cmd: WagerCommand, messageId = uuid()): WagerChannel {
  return {
    type: 'SQS',
    consumerName: 'wager-consumer',
    messageId,
    messageHash: hashOf(cmd.idempotencyKey),
  };
}

function viewOf(result: WagerResult) {
  if (result.type !== 'RESULT') {
    throw new Error(`expected RESULT, got ${result.type}`);
  }

  return result;
}

async function balanceOf(walletId: string): Promise<string> {
  return (await app.getWallet.execute(walletId))?.balance.amount ?? 'missing';
}

async function count(table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );

  return rows[0]?.n ?? 0;
}

describe('ProcessWagerTransaction — apply and replay', () => {
  test('a BET is processed once and its replay returns the recorded balance', async () => {
    const wallet = await openWallet();
    const cmd = wagerCommand(wallet);
    const first = viewOf(await app.processWager.execute(cmd, HTTP));

    expect(first.replay).toBe(false);
    expect(first.view.status).toBe(WagerStatus.Processed);
    expect(first.view.balance).toEqual({ amount: '975.00', currency: 'BRL' });

    await app.processWager.execute(wagerCommand(wallet), HTTP);
    const replay = viewOf(await app.processWager.execute(cmd, HTTP));

    expect(replay.replay).toBe(true);
    expect(replay.view).toEqual(first.view);
    expect(await balanceOf(wallet.id)).toBe('950.00');
    expect(
      t.metrics.counter('idempotent_replays_total', { channel: 'HTTP' }),
    ).toBeGreaterThanOrEqual(1);
  });

  test('same key with another payload is an IDEMPOTENCY_CONFLICT, not a replay', async () => {
    const wallet = await openWallet();
    const cmd = wagerCommand(wallet);

    await app.processWager.execute(cmd, HTTP);
    const conflict = await app.processWager.execute(
      { ...cmd, money: { amount: '26.00', currency: 'BRL' } },
      HTTP,
    );

    expect(conflict).toEqual({ type: 'IDEMPOTENCY_CONFLICT' });
    expect(await balanceOf(wallet.id)).toBe('975.00');
  });

  test('same external id under another key is an EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await openWallet();
    const cmd = wagerCommand(wallet);

    await app.processWager.execute(cmd, HTTP);

    expect(await app.processWager.execute({ ...cmd, idempotencyKey: 'other-key' }, HTTP)).toEqual({
      type: 'EXTERNAL_ID_CONFLICT',
    });
    expect(await count('wager_transactions', "kind = 'BET'")).toBe(1);
  });

  test('a BET above the balance is REJECTED, recorded and has no ledger entry', async () => {
    const wallet = await openWallet('10.00');
    const result = viewOf(await app.processWager.execute(wagerCommand(wallet), HTTP));

    expect(result.view).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      balance: { amount: '10.00', currency: 'BRL' },
    });
    expect(await count('wager_transactions', "status = 'REJECTED'")).toBe(1);
    expect(await count('wallet_ledger_entries')).toBe(1);
    expect(await count('outbox_messages', "event_type = 'WagerTransactionRejected'")).toBe(1);
  });

  test('a missing wallet is REJECTED WALLET_NOT_FOUND and stays so after the wallet exists', async () => {
    const ghost = { id: uuid(), playerId: uuid() };
    const cmd = wagerCommand(ghost);
    const first = viewOf(await app.processWager.execute(cmd, HTTP));

    expect(first.view).toMatchObject({
      status: 'REJECTED',
      failureCode: 'WALLET_NOT_FOUND',
      balance: null,
    });
    await openWallet('100.00', ghost.playerId);
    const again = viewOf(await app.processWager.execute(cmd, HTTP));

    expect(again.replay).toBe(true);
    expect(again.view.failureCode).toBe('WALLET_NOT_FOUND');
  });

  test('LOSS and a zero WIN are PROCESSED without a ledger entry or a version change', async () => {
    const wallet = await openWallet('100.00');
    const loss = viewOf(
      await app.processWager.execute(
        wagerCommand(wallet, { kind: WagerKind.Loss, money: { amount: '5.00', currency: 'BRL' } }),
        HTTP,
      ),
    );
    const win = viewOf(
      await app.processWager.execute(
        wagerCommand(wallet, { kind: WagerKind.Win, money: { amount: '0.00', currency: 'BRL' } }),
        HTTP,
      ),
    );

    expect([loss.view.status, win.view.status]).toEqual([
      WagerStatus.Processed,
      WagerStatus.Processed,
    ]);
    expect((await app.getWallet.execute(wallet.id))?.version).toBe(1);
    expect(await count('wallet_ledger_entries')).toBe(1);
  });

  test('PLAYER_WALLET_MISMATCH never exposes the balance', async () => {
    const wallet = await openWallet('100.00');
    const result = viewOf(
      await app.processWager.execute(wagerCommand({ id: wallet.id, playerId: uuid() }), HTTP),
    );

    expect(result.view).toMatchObject({
      status: 'REJECTED',
      failureCode: 'PLAYER_WALLET_MISMATCH',
      balance: null,
    });
  });

  test('an unknown or inactive provider is REJECTED UNKNOWN_PROVIDER', async () => {
    const wallet = await openWallet('100.00');
    const inactive = viewOf(
      await app.processWager.execute(
        wagerCommand(wallet, { providerId: 'provider-inactive' }),
        HTTP,
      ),
    );

    expect(inactive.view.failureCode).toBe('UNKNOWN_PROVIDER');
  });
});

describe('ProcessWagerTransaction — references', () => {
  test('a ROLLBACK before its BET waits as PENDING_REFERENCE, and a resend does not resolve it', async () => {
    const wallet = await openWallet('100.00');
    const rollback = wagerCommand(wallet, {
      kind: WagerKind.Rollback,
      referenceExternalTransactionId: 'bet-later',
    });
    const first = viewOf(await app.processWager.execute(rollback, HTTP));

    expect(first.view).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    await app.processWager.execute(
      wagerCommand(wallet, { externalTransactionId: 'bet-later' }),
      HTTP,
    );
    const resend = viewOf(await app.processWager.execute(rollback, HTTP));

    expect(resend.replay).toBe(true);
    expect(resend.view.status).toBe(WagerStatus.PendingReference);
    const { rows } = await db.query<{ next_attempt_at: Date }>(
      'SELECT next_attempt_at FROM wager_transactions WHERE id = $1',
      [first.view.transactionId],
    );

    expect(rows[0]?.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('BET → REFUND → ROLLBACK(REFUND) ends at the post-BET balance', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const refund = wagerCommand(wallet, {
      kind: WagerKind.Refund,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const undo = wagerCommand(wallet, {
      kind: WagerKind.Rollback,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: refund.externalTransactionId,
    });

    expect(viewOf(await app.processWager.execute(bet, HTTP)).view.balance?.amount).toBe('70.00');
    expect(viewOf(await app.processWager.execute(refund, HTTP)).view.balance?.amount).toBe(
      '100.00',
    );
    expect(viewOf(await app.processWager.execute(undo, HTTP)).view.balance?.amount).toBe('70.00');
    expect(await balanceOf(wallet.id)).toBe('70.00');
  });

  test('a REFUND of a BET with an active WIN is BET_ALREADY_SETTLED', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });

    await app.processWager.execute(bet, HTTP);
    await app.processWager.execute(
      wagerCommand(wallet, {
        kind: WagerKind.Win,
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      HTTP,
    );
    const refund = viewOf(
      await app.processWager.execute(
        wagerCommand(wallet, {
          kind: WagerKind.Refund,
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        HTTP,
      ),
    );

    expect(refund.view.failureCode).toBe('BET_ALREADY_SETTLED');
    expect(await balanceOf(wallet.id)).toBe('120.00');
  });

  test('a second REFUND of the same BET is ALREADY_REVERSED', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const refund = (n: number) =>
      wagerCommand(wallet, {
        externalTransactionId: `refund-${n}-${bet.externalTransactionId}`,
        kind: WagerKind.Refund,
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      });

    await app.processWager.execute(bet, HTTP);
    await app.processWager.execute(refund(1), HTTP);

    expect(viewOf(await app.processWager.execute(refund(2), HTTP)).view.failureCode).toBe(
      'ALREADY_REVERSED',
    );
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('ProcessWagerTransaction — deterministic failures', () => {
  test.each([['HTTP'], ['SQS']])(
    '%s: a WIN that overflows NUMERIC(19,2) is recorded FAILED with an event; the balance is untouched; the resend replays FAILED',
    async (channelType) => {
      const wallet = await openWallet('99999999999999999.00');
      const cmd = wagerCommand(wallet, {
        kind: WagerKind.Win,
        money: { amount: '1.00', currency: 'BRL' },
      });
      const channel = channelType === 'HTTP' ? HTTP : sqs(cmd);
      const first = viewOf(await app.processWager.execute(cmd, channel));

      expect(first.replay).toBe(false);
      expect(first.view).toMatchObject({
        status: 'FAILED',
        failureCode: 'UNEXPECTED_PROCESSING_ERROR',
        balance: null,
      });
      expect(await balanceOf(wallet.id)).toBe('99999999999999999.00');
      expect(await count('outbox_messages', "event_type = 'WagerTransactionFailed'")).toBe(1);
      const again = viewOf(
        await app.processWager.execute(cmd, channelType === 'HTTP' ? HTTP : sqs(cmd)),
      );

      expect(again.replay).toBe(true);
      expect(again.view).toEqual(first.view);
    },
  );
});

describe('ProcessWagerTransaction — SQS channel', () => {
  test('the inbox dedupes the same message and flags a different payload under the same id', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet);
    const channel = sqs(cmd, 'msg-1');

    expect(viewOf(await app.processWager.execute(cmd, channel)).replay).toBe(false);
    expect(await app.processWager.execute(cmd, channel)).toEqual({ type: 'INBOX_DUPLICATE' });
    expect(
      await app.processWager.execute(cmd, {
        ...channel,
        messageHash: hashOf('another-payload'),
      } as WagerChannel),
    ).toEqual({ type: 'INBOX_PAYLOAD_CONFLICT' });
    const { rows } = await db.query<{ processed_at: Date | null }>(
      "SELECT processed_at FROM inbox_messages WHERE message_id = 'msg-1'",
    );

    expect(rows[0]?.processed_at).not.toBeNull();
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });

  test('a new message carrying an already processed key is a replay', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet);

    await app.processWager.execute(cmd, HTTP);
    const viaSqs = viewOf(await app.processWager.execute(cmd, sqs(cmd)));

    expect(viaSqs.replay).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });
});

describe('Queries', () => {
  test('GetTransaction hides another provider’s transaction', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet);
    const { view } = viewOf(await app.processWager.execute(cmd, HTTP));

    expect((await app.getTransaction.byId(view.transactionId, { role: 'operator' }))?.status).toBe(
      WagerStatus.Processed,
    );
    expect(
      (
        await app.getTransaction.byExternalId('provider-a', cmd.externalTransactionId, {
          role: 'provider',
          providerId: 'provider-a',
        })
      )?.transactionId,
    ).toBe(view.transactionId);
    expect(
      await app.getTransaction.byId(view.transactionId, {
        role: 'provider',
        providerId: 'provider-b',
      }),
    ).toBeNull();
    expect(await app.getTransaction.byId(uuid(), { role: 'operator' })).toBeNull();
  });

  test('ListLedger pages newest first with an opaque cursor', async () => {
    const wallet = await openWallet('100.00');

    for (let i = 0; i < 3; i++) {
      await app.processWager.execute(
        wagerCommand(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
        HTTP,
      );
    }
    const first = await app.listLedger.execute(wallet.id, { limit: 2 });
    const second = await app.listLedger.execute(wallet.id, {
      limit: 2,
      cursor: first.nextCursor ?? '',
    });

    expect(first.items.map((e) => e.walletVersion)).toEqual([4, 3]);
    expect(second.items.map((e) => e.walletVersion)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]).toMatchObject({
      direction: 'DEBIT',
      money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '98.00', currency: 'BRL' },
      balanceAfter: { amount: '97.00', currency: 'BRL' },
    });
  });

  test('ListLedger clamps the limit to 200 and rejects a bad limit', async () => {
    const wallet = await openWallet('1.00');

    expect((await app.listLedger.execute(wallet.id, { limit: 500 })).items).toHaveLength(1);
    expect(app.listLedger.execute(wallet.id, { limit: 0 })).rejects.toThrow();
  });
});
