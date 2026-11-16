import { describe, expect, test } from 'bun:test';
import { EventFactory } from '../../../src/modules/messaging/domain/event-factory';
import { WalletBalanceChanged } from '../../../src/modules/messaging/domain/events/wallet-balance-changed';
import { WagerTransactionProcessed } from '../../../src/modules/messaging/domain/events/wager-transaction-processed';
import { InvalidMessageStateError } from '../../../src/modules/messaging/domain/messaging.errors';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { WagerKind } from '../../../src/modules/wagering/domain/wager-kind';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import { WagerStatus } from '../../../src/modules/wagering/domain/wager-status';
import type { Clock } from '../../../src/shared/time/clock';
import type { IdGenerator } from '../../../src/shared/ids/id-generator';
import { brl, T0, wager } from '../../support/domain-builders';

const clock: Clock = { now: () => T0 };
let n = 0;
const ids: IdGenerator = { next: () => `event-${++n}` };
const factory = new EventFactory(ids, clock);
const ctx = { correlationId: 'corr-1', causationId: 'msg-1' };

function processBet(amount: string) {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    at: T0,
    opening: { transactionId: 'opening', entryId: 'opening-entry' },
  });
  const tx = wager({ kind: WagerKind.Bet, money: brl(amount) });
  const entry = wallet.debit({ money: tx.money, transactionId: tx.id, entryId: 'entry-1', at: T0 });

  tx.markProcessed({ observedBalance: wallet.balance, at: T0 });

  return { tx, entry };
}

function processedWithoutMovement(kind: WagerKind, amount: string): WagerTransaction {
  const tx = wager({ kind, money: brl(amount) });

  tx.markProcessed({ observedBalance: brl('100.00'), at: T0 });

  return tx;
}

describe('EventFactory', () => {
  test('a processed BET yields WagerTransactionProcessed and WalletBalanceChanged', () => {
    const { tx, entry } = processBet('25.00');
    const messages = factory.forProcessed(tx, entry, ctx);

    expect(messages.map((m) => m.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(messages.every((m) => m.partitionKey === 'wallet-1')).toBe(true);
  });

  test('a LOSS yields only WagerTransactionProcessed', () => {
    const messages = factory.forProcessed(
      processedWithoutMovement(WagerKind.Loss, '0.00'),
      null,
      ctx,
    );

    expect(messages.map((m) => m.eventType)).toEqual(['WagerTransactionProcessed']);
  });

  test('a zero-amount WIN yields only WagerTransactionProcessed', () => {
    const messages = factory.forProcessed(
      processedWithoutMovement(WagerKind.Win, '0.00'),
      null,
      ctx,
    );

    expect(messages.map((m) => m.eventType)).toEqual(['WagerTransactionProcessed']);
  });

  test('rejected, pending and failed transactions yield one event each', () => {
    const rejected = wager();
    const pending = wager({ kind: WagerKind.Refund, referenceExternalTransactionId: 'ext-bet' });
    const failed = wager();

    rejected.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('5.00'), at: T0 });
    pending.markPendingReference({
      observedBalance: brl('5.00'),
      nextAttemptAt: T0,
      expiresAt: T0,
    });
    failed.fail({ code: 'UNEXPECTED_PROCESSING_ERROR', at: T0 });

    expect(factory.forRejected(rejected, ctx).map((m) => m.eventType)).toEqual([
      'WagerTransactionRejected',
    ]);
    expect(factory.forPending(pending, ctx).map((m) => m.eventType)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect(factory.forFailed(failed, ctx).map((m) => m.eventType)).toEqual([
      'WagerTransactionFailed',
    ]);
  });

  test('refuses to describe a transaction in another state', () => {
    expect(() => factory.forRejected(wager(), ctx)).toThrow(InvalidMessageStateError);
    expect(() => factory.forProcessed(wager(), null, ctx)).toThrow(InvalidMessageStateError);
  });

  test('refuses an inconsistent rejected transaction that has no failure code', () => {
    const inconsistent = WagerTransaction.rehydrate({
      ...wager().toState(),
      status: WagerStatus.Rejected,
      failureCode: null,
    });

    expect(() => factory.forRejected(inconsistent, ctx)).toThrow(InvalidMessageStateError);
  });

  test('a balance movement without its ledger entry is refused', () => {
    expect(() => factory.forProcessed(processBet('25.00').tx, null, ctx)).toThrow(
      InvalidMessageStateError,
    );
  });
});

describe('integration event envelope', () => {
  test('WalletBalanceChanged carries money as strings and the wallet version', () => {
    const { tx, entry } = processBet('25.00');
    const [, balanceChanged] = factory.forProcessed(tx, entry, ctx);
    const payload = balanceChanged?.payload as {
      eventType: string;
      version: number;
      aggregateId: string;
      data: Record<string, unknown>;
    };

    expect(payload.eventType).toBe('WalletBalanceChanged');
    expect(payload.version).toBe(1);
    expect(payload.aggregateId).toBe('wallet-1');
    expect(payload.data).toEqual({
      walletId: 'wallet-1',
      transactionId: tx.id,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('transaction events are keyed by the transaction and carry the observed balance', () => {
    const { tx, entry } = processBet('25.00');
    const [processed] = factory.forProcessed(tx, entry, ctx);
    const payload = processed?.payload as { aggregateId: string; data: Record<string, unknown> };

    expect(payload.aggregateId).toBe(tx.id);
    expect(payload.data).toMatchObject({
      transactionId: tx.id,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
    });
  });

  test('the envelope has the README fields with an ISO-8601 occurredAt', () => {
    const { tx, entry } = processBet('25.00');
    const [processed] = factory.forProcessed(tx, entry, ctx);

    expect(processed?.payload).toMatchObject({
      eventId: processed?.id,
      eventType: 'WagerTransactionProcessed',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-11-15T12:00:00.000Z',
      version: 1,
    });
  });

  test('payloads never contain numbers for money', () => {
    const { tx, entry } = processBet('25.00');
    const serialized = JSON.stringify(factory.forProcessed(tx, entry, ctx).map((m) => m.payload));

    expect(serialized).not.toMatch(/"(amount|balance\w*|money)":\s*-?\d/);
  });

  test('eventType and version come from the event class, not from loose strings', () => {
    const { tx, entry } = processBet('25.00');
    const [processed, balanceChanged] = factory.forProcessed(tx, entry, ctx);

    expect(processed?.eventType).toBe(WagerTransactionProcessed.TYPE);
    expect(balanceChanged?.eventType).toBe(WalletBalanceChanged.TYPE);
    expect(balanceChanged?.eventVersion).toBe(WalletBalanceChanged.VERSION);
  });

  test('the payload is immutable', () => {
    const { tx, entry } = processBet('25.00');
    const [processed] = factory.forProcessed(tx, entry, ctx);

    expect(Object.isFrozen(processed?.payload)).toBe(true);
  });
});
