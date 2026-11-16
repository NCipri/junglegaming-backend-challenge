import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/money/money';
import { LedgerDirection } from '../../../src/modules/wallet/domain/ledger-direction';
import { WagerKind } from '../../../src/modules/wagering/domain/wager-kind';
import { WagerStatus } from '../../../src/modules/wagering/domain/wager-status';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import {
  InvalidTransactionStateError,
  InvalidWagerAmountError,
} from '../../../src/modules/wagering/domain/wager.errors';
import { brl, processed, T0, wager } from '../../support/domain-builders';

const later = new Date('2026-11-15T12:00:01.000Z');

describe('WagerTransaction.create', () => {
  test('is born PENDING with no outcome yet', () => {
    const tx = wager();

    expect(tx.status).toBe(WagerStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.attempts).toBe(0);
  });

  test.each([WagerKind.Bet, WagerKind.Refund, WagerKind.Opening])(
    'rejects a zero amount for %s',
    (kind) => {
      expect(() => wager({ kind, money: brl('0.00') })).toThrow(InvalidWagerAmountError);
    },
  );

  test('the zero-amount error carries INVALID_AMOUNT_ZERO', () => {
    try {
      wager({ kind: WagerKind.Bet, money: brl('0.00') });
    } catch (error) {
      expect((error as InvalidWagerAmountError).code).toBe('INVALID_AMOUNT_ZERO');

      return;
    }
    throw new Error('expected an error');
  });

  test.each([WagerKind.Loss, WagerKind.Win, WagerKind.Rollback])(
    'accepts a zero amount for %s',
    (kind) => {
      expect(wager({ kind, money: brl('0.00') }).status).toBe(WagerStatus.Pending);
    },
  );

  test('rejects a negative amount', () => {
    expect(() => wager({ money: brl('0.00').subtract(brl('1.00')) })).toThrow(
      InvalidWagerAmountError,
    );
  });

  test('does not reject a missing reference: that is a persisted business rejection', () => {
    expect(wager({ kind: WagerKind.Refund }).referenceExternalTransactionId).toBeUndefined();
  });
});

describe('WagerTransaction identity', () => {
  test('exposes exactly the data it was created with', () => {
    const tx = wager({
      id: 'tx-identity',
      providerId: 'provider-a',
      externalTransactionId: 'ext-identity',
      idempotencyKey: 'provider-a:ext-identity',
      payloadHash: 'payload-hash',
      walletId: 'wallet-9',
      playerId: 'player-9',
      roundId: 'round-9',
      gameId: 'game-9',
      kind: WagerKind.Win,
      money: brl('12.34'),
      referenceExternalTransactionId: 'ext-bet',
      correlationId: 'corr-9',
      createdAt: T0,
    });

    expect({
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      correlationId: tx.correlationId,
      createdAt: tx.createdAt,
    }).toEqual({
      id: 'tx-identity',
      providerId: 'provider-a',
      externalTransactionId: 'ext-identity',
      idempotencyKey: 'provider-a:ext-identity',
      payloadHash: 'payload-hash',
      walletId: 'wallet-9',
      playerId: 'player-9',
      roundId: 'round-9',
      gameId: 'game-9',
      kind: WagerKind.Win,
      amount: { amount: '12.34', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-bet',
      correlationId: 'corr-9',
      createdAt: T0,
    });
  });

  test('does not leak its creation date for mutation', () => {
    const tx = wager({ createdAt: new Date(T0) });

    tx.createdAt.setFullYear(1999);
    expect(tx.createdAt).toEqual(T0);
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING → PROCESSED records outcome, reference and observed balance', () => {
    const tx = wager();

    tx.markProcessed({ referenceTransactionId: 'ref-1', observedBalance: brl('90.00'), at: later });
    expect(tx.status).toBe(WagerStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-1');
    expect(tx.observedBalance?.toJSON().amount).toBe('90.00');
    expect(tx.processedAt).toEqual(later);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED records the failure code', () => {
    const tx = wager();

    tx.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('5.00'), at: later });
    expect(tx.status).toBe(WagerStatus.Rejected);
    expect(tx.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED allows an unknown balance', () => {
    const tx = wager();

    tx.reject({ code: 'WALLET_NOT_FOUND', observedBalance: null, at: later });
    expect(tx.observedBalance).toBeNull();
  });

  test('PENDING → FAILED records UNEXPECTED_PROCESSING_ERROR', () => {
    const tx = wager();

    tx.fail({ code: 'UNEXPECTED_PROCESSING_ERROR', at: later });
    expect(tx.status).toBe(WagerStatus.Failed);
    expect(tx.failureCode).toBe('UNEXPECTED_PROCESSING_ERROR');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE schedules the next attempt and the expiry', () => {
    const tx = wager({ kind: WagerKind.Refund, referenceExternalTransactionId: 'ext-bet' });
    const expiresAt = new Date('2026-11-16T12:00:00.000Z');

    tx.markPendingReference({ observedBalance: brl('10.00'), nextAttemptAt: later, expiresAt });
    expect(tx.status).toBe(WagerStatus.PendingReference);
    expect(tx.nextAttemptAt).toEqual(later);
    expect(tx.expiresAt).toEqual(expiresAt);
    expect(tx.isTerminal()).toBe(false);
  });

  test('PENDING_REFERENCE → retry, then PROCESSED or REJECTED', () => {
    const pendingThenProcessed = wager({ kind: WagerKind.Refund });
    const pendingThenRejected = wager({ kind: WagerKind.Refund });

    for (const tx of [pendingThenProcessed, pendingThenRejected]) {
      tx.markPendingReference({ observedBalance: null, nextAttemptAt: later, expiresAt: later });
      tx.scheduleRetry(new Date('2026-11-15T12:00:02.000Z'));
      expect(tx.attempts).toBe(1);
    }
    pendingThenProcessed.markProcessed({ observedBalance: brl('20.00'), at: later });
    pendingThenRejected.reject({ code: 'REFERENCE_NOT_FOUND', observedBalance: null, at: later });
    expect(pendingThenProcessed.status).toBe(WagerStatus.Processed);
    expect(pendingThenRejected.failureCode).toBe('REFERENCE_NOT_FOUND');
  });

  test.each([
    [
      'PROCESSED',
      (tx: WagerTransaction) => tx.markProcessed({ observedBalance: brl('1.00'), at: T0 }),
    ],
    [
      'REJECTED',
      (tx: WagerTransaction) =>
        tx.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: null, at: T0 }),
    ],
    ['FAILED', (tx: WagerTransaction) => tx.fail({ code: 'UNEXPECTED_PROCESSING_ERROR', at: T0 })],
  ])('a %s transaction refuses every further transition', (_, toTerminal) => {
    const attempts: Array<(tx: WagerTransaction) => void> = [
      (tx) => tx.markProcessed({ observedBalance: brl('1.00'), at: T0 }),
      (tx) => tx.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: null, at: T0 }),
      (tx) => tx.fail({ code: 'UNEXPECTED_PROCESSING_ERROR', at: T0 }),
      (tx) => tx.markPendingReference({ observedBalance: null, nextAttemptAt: T0, expiresAt: T0 }),
      (tx) => tx.scheduleRetry(T0),
    ];

    for (const attempt of attempts) {
      const tx = wager();

      toTerminal(tx);
      expect(() => attempt(tx)).toThrow(InvalidTransactionStateError);
    }
  });

  test('scheduleRetry is only valid while waiting for a reference', () => {
    expect(() => wager().scheduleRetry(later)).toThrow(InvalidTransactionStateError);
  });

  test('a pending reference cannot be marked pending again', () => {
    const tx = wager({ kind: WagerKind.Refund });

    tx.markPendingReference({ observedBalance: null, nextAttemptAt: later, expiresAt: later });
    expect(() =>
      tx.markPendingReference({ observedBalance: null, nextAttemptAt: later, expiresAt: later }),
    ).toThrow(InvalidTransactionStateError);
  });

  test('the state error carries INVALID_TRANSACTION_STATE', () => {
    const tx = processed();

    try {
      tx.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: null, at: T0 });
    } catch (error) {
      expect((error as InvalidTransactionStateError).code).toBe('INVALID_TRANSACTION_STATE');

      return;
    }
    throw new Error('expected an error');
  });
});

describe('WagerTransaction queries', () => {
  test('ledgerDirectionFor maps each kind', () => {
    expect(wager({ kind: WagerKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(wager({ kind: WagerKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wager({ kind: WagerKind.Refund }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wager({ kind: WagerKind.Opening }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wager({ kind: WagerKind.Loss }).ledgerDirectionFor()).toBeNull();
    expect(wager({ kind: WagerKind.Win, money: brl('0.00') }).ledgerDirectionFor()).toBeNull();
  });

  test('a ROLLBACK inverts its reference', () => {
    const rollback = wager({ kind: WagerKind.Rollback });

    expect(rollback.ledgerDirectionFor(wager({ kind: WagerKind.Bet }))).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback.ledgerDirectionFor(wager({ kind: WagerKind.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(wager({ kind: WagerKind.Refund }))).toBe(
      LedgerDirection.Debit,
    );
  });

  test('a ROLLBACK without its reference has no direction to compute', () => {
    expect(() => wager({ kind: WagerKind.Rollback }).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('affectsBalance is false for LOSS and for zero amounts', () => {
    expect(wager({ kind: WagerKind.Bet }).affectsBalance()).toBe(true);
    expect(wager({ kind: WagerKind.Loss }).affectsBalance()).toBe(false);
    expect(wager({ kind: WagerKind.Win, money: brl('0.00') }).affectsBalance()).toBe(false);
  });

  test('requiresReference is true only for REFUND and ROLLBACK', () => {
    expect(wager({ kind: WagerKind.Refund }).requiresReference()).toBe(true);
    expect(wager({ kind: WagerKind.Rollback }).requiresReference()).toBe(true);
    expect(wager({ kind: WagerKind.Win }).requiresReference()).toBe(false);
    expect(wager({ kind: WagerKind.Bet }).requiresReference()).toBe(false);
  });

  test('matchesPayload tells a replay from an idempotency conflict', () => {
    const tx = wager({ payloadHash: 'same-hash' });

    expect(tx.matchesPayload('same-hash')).toBe(true);
    expect(tx.matchesPayload('hash-of-another-amount')).toBe(false);
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('round-trips every field through toState without re-validating transitions', () => {
    const tx = processed({ kind: WagerKind.Win, referenceExternalTransactionId: 'ext-bet' });
    const copy = WagerTransaction.rehydrate(tx.toState());

    expect(copy.toState()).toEqual(tx.toState());
    expect(copy.status).toBe(WagerStatus.Processed);
  });

  test('accepts a zero-amount BET from storage (rehydrate never re-validates)', () => {
    const state = { ...wager().toState(), money: Money.zero('BRL') };

    expect(WagerTransaction.rehydrate(state).money.isZero()).toBe(true);
  });
});
