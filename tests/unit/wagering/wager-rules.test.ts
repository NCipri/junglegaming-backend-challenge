import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/money/money';
import { LedgerDirection } from '../../../src/modules/wallet/domain/ledger-direction';
import { WagerKind } from '../../../src/modules/wagering/domain/wager-kind';
import { decideWager } from '../../../src/modules/wagering/domain/wager-rules';
import type {
  ReferenceContext,
  WagerContext,
} from '../../../src/modules/wagering/domain/wager-rules.types';
import type { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import { brl, processed, T0, wager, walletWith } from '../../support/domain-builders';

const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const activeProvider = { id: 'provider-a', active: true };
const notProvided: ReferenceContext = { state: 'NOT_PROVIDED' };

function found(
  transaction: WagerTransaction,
  facts: Partial<{
    hasAnyReversal: boolean;
    hasEffectiveReversal: boolean;
    hasActiveSettlingWin: boolean;
  }> = {},
): ReferenceContext {
  return {
    state: 'FOUND',
    transaction,
    hasAnyReversal: false,
    hasEffectiveReversal: false,
    hasActiveSettlingWin: false,
    ...facts,
  };
}

function context(
  overrides: Partial<WagerContext> & Pick<WagerContext, 'transaction'>,
): WagerContext {
  return {
    provider: activeProvider,
    wallet: walletWith('100.00'),
    reference: notProvided,
    ...overrides,
  };
}

const bet = (amount = '10.00') => processed({ kind: WagerKind.Bet, money: brl(amount) });
const refundOf = (ref: WagerTransaction, amount = '10.00') =>
  wager({
    kind: WagerKind.Refund,
    money: brl(amount),
    referenceExternalTransactionId: ref.externalTransactionId,
  });
const rollbackOf = (ref: WagerTransaction, amount = ref.money.toJSON().amount) =>
  wager({
    kind: WagerKind.Rollback,
    money: brl(amount),
    referenceExternalTransactionId: ref.externalTransactionId,
  });

describe('decideWager — one rule per failure code, in rule order', () => {
  test('OPENING_NOT_ALLOWED', () => {
    expect(decideWager(context({ transaction: wager({ kind: WagerKind.Opening }) }))).toEqual({
      type: 'REJECT',
      code: 'OPENING_NOT_ALLOWED',
    });
  });

  test('UNKNOWN_PROVIDER when the provider is missing', () => {
    expect(decideWager(context({ transaction: wager(), provider: null }))).toEqual({
      type: 'REJECT',
      code: 'UNKNOWN_PROVIDER',
    });
  });

  test('UNKNOWN_PROVIDER when the provider is inactive', () => {
    expect(
      decideWager(context({ transaction: wager(), provider: { id: 'provider-a', active: false } })),
    ).toEqual({ type: 'REJECT', code: 'UNKNOWN_PROVIDER' });
  });

  test('WALLET_NOT_FOUND', () => {
    expect(decideWager(context({ transaction: wager(), wallet: null }))).toEqual({
      type: 'REJECT',
      code: 'WALLET_NOT_FOUND',
    });
  });

  test('PLAYER_WALLET_MISMATCH', () => {
    expect(
      decideWager(
        context({
          transaction: wager(),
          wallet: walletWith('100.00', { playerId: 'someone-else' }),
        }),
      ),
    ).toEqual({ type: 'REJECT', code: 'PLAYER_WALLET_MISMATCH' });
  });

  test('CURRENCY_MISMATCH', () => {
    const tx = wager({ kind: WagerKind.Bet, money: usd('10.00') });

    expect(decideWager(context({ transaction: tx }))).toEqual({
      type: 'REJECT',
      code: 'CURRENCY_MISMATCH',
    });
  });

  test('REFERENCE_REQUIRED for a REFUND without reference', () => {
    expect(decideWager(context({ transaction: wager({ kind: WagerKind.Refund }) }))).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_REQUIRED',
    });
  });

  test('REFERENCE_REQUIRED for a ROLLBACK without reference', () => {
    expect(decideWager(context({ transaction: wager({ kind: WagerKind.Rollback }) }))).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_REQUIRED',
    });
  });

  test('PEND when the reference has not arrived', () => {
    const tx = wager({ kind: WagerKind.Refund, referenceExternalTransactionId: 'not-yet' });

    expect(decideWager(context({ transaction: tx, reference: { state: 'MISSING' } }))).toEqual({
      type: 'PEND',
    });
  });

  test('PEND when the reference is itself waiting for its reference', () => {
    const waitingRefund = wager({
      kind: WagerKind.Refund,
      referenceExternalTransactionId: 'bet-x',
    });

    waitingRefund.markPendingReference({ observedBalance: null, nextAttemptAt: T0, expiresAt: T0 });
    expect(
      decideWager(
        context({ transaction: rollbackOf(waitingRefund), reference: found(waitingRefund) }),
      ),
    ).toEqual({ type: 'PEND' });
  });

  test('REFERENCE_NOT_PROCESSED when the reference was rejected', () => {
    const rejectedBet = wager({ kind: WagerKind.Bet });

    rejectedBet.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: null, at: T0 });
    expect(
      decideWager(context({ transaction: refundOf(rejectedBet), reference: found(rejectedBet) })),
    ).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_NOT_PROCESSED',
    });
  });

  test('REFERENCE_NOT_PROCESSED when the reference failed', () => {
    const failedBet = wager({ kind: WagerKind.Bet });

    failedBet.fail({ code: 'UNEXPECTED_PROCESSING_ERROR', at: T0 });
    expect(
      decideWager(context({ transaction: refundOf(failedBet), reference: found(failedBet) })),
    ).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_NOT_PROCESSED',
    });
  });

  test.each([
    ['REFUND of a WIN', WagerKind.Refund, WagerKind.Win],
    ['ROLLBACK of a LOSS', WagerKind.Rollback, WagerKind.Loss],
    ['ROLLBACK of a ROLLBACK', WagerKind.Rollback, WagerKind.Rollback],
    ['WIN referencing a WIN', WagerKind.Win, WagerKind.Win],
  ])('INVALID_REFERENCE_KIND for %s', (_, kind, referenceKind) => {
    const ref = processed({ kind: referenceKind, money: brl('10.00') });
    const tx = wager({
      kind,
      money: brl('10.00'),
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    expect(decideWager(context({ transaction: tx, reference: found(ref) }))).toEqual({
      type: 'REJECT',
      code: 'INVALID_REFERENCE_KIND',
    });
  });

  test.each([
    ['another provider', { providerId: 'provider-b' }],
    ['another player', { playerId: 'player-2' }],
    ['another wallet', { walletId: 'wallet-2' }],
    ['another round', { roundId: 'round-2' }],
  ])('REFERENCE_MISMATCH when the reference belongs to %s', (_, diff) => {
    const ref = processed({ kind: WagerKind.Bet, ...diff });

    expect(decideWager(context({ transaction: refundOf(ref), reference: found(ref) }))).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_MISMATCH',
    });
  });

  test('REFERENCE_MISMATCH when the reference uses another currency', () => {
    const ref = processed({ kind: WagerKind.Bet, money: usd('10.00') });

    expect(decideWager(context({ transaction: refundOf(ref), reference: found(ref) }))).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_MISMATCH',
    });
  });

  test('REFERENCE_AMOUNT_MISMATCH for a partial reversal', () => {
    const ref = bet('10.00');

    expect(
      decideWager(context({ transaction: refundOf(ref, '5.00'), reference: found(ref) })),
    ).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_AMOUNT_MISMATCH',
    });
  });

  test('ALREADY_REVERSED when the reference already has a reversal (even an undone one)', () => {
    const ref = bet();

    expect(
      decideWager(
        context({ transaction: refundOf(ref), reference: found(ref, { hasAnyReversal: true }) }),
      ),
    ).toEqual({ type: 'REJECT', code: 'ALREADY_REVERSED' });
  });

  test('ALREADY_REVERSED for a WIN on a BET with an effective reversal', () => {
    const ref = bet();
    const win = wager({
      kind: WagerKind.Win,
      money: brl('50.00'),
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    expect(
      decideWager(
        context({
          transaction: win,
          reference: found(ref, { hasAnyReversal: true, hasEffectiveReversal: true }),
        }),
      ),
    ).toEqual({ type: 'REJECT', code: 'ALREADY_REVERSED' });
  });

  test('BET_ALREADY_SETTLED for a REFUND of a BET with an active WIN', () => {
    const ref = bet();

    expect(
      decideWager(
        context({
          transaction: refundOf(ref),
          reference: found(ref, { hasActiveSettlingWin: true }),
        }),
      ),
    ).toEqual({ type: 'REJECT', code: 'BET_ALREADY_SETTLED' });
  });

  test('BET_ALREADY_SETTLED for a ROLLBACK of a BET with an active WIN', () => {
    const ref = bet();

    expect(
      decideWager(
        context({
          transaction: rollbackOf(ref),
          reference: found(ref, { hasActiveSettlingWin: true }),
        }),
      ),
    ).toEqual({ type: 'REJECT', code: 'BET_ALREADY_SETTLED' });
  });

  test('INSUFFICIENT_BALANCE for a BET above the balance', () => {
    expect(decideWager(context({ transaction: wager({ money: brl('100.01') }) }))).toEqual({
      type: 'REJECT',
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  test('REVERSAL_WOULD_OVERDRAW for a ROLLBACK of a WIN above the balance', () => {
    const win = processed({ kind: WagerKind.Win, money: brl('150.00') });

    expect(
      decideWager(
        context({
          transaction: rollbackOf(win),
          wallet: walletWith('100.00'),
          reference: found(win),
        }),
      ),
    ).toEqual({ type: 'REJECT', code: 'REVERSAL_WOULD_OVERDRAW' });
  });
});

describe('decideWager — applying', () => {
  test('section 8 scenario in unit form: 100.00, then two BETs of 80.00', () => {
    expect(
      decideWager(
        context({ transaction: wager({ money: brl('80.00') }), wallet: walletWith('100.00') }),
      ),
    ).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Debit,
    });
    expect(
      decideWager(
        context({ transaction: wager({ money: brl('80.00') }), wallet: walletWith('20.00') }),
      ),
    ).toEqual({
      type: 'REJECT',
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  test('a BET of exactly the balance is applied', () => {
    expect(decideWager(context({ transaction: wager({ money: brl('100.00') }) })).type).toBe(
      'APPLY',
    );
  });

  test('a REFUND of a BET credits and points at the BET', () => {
    const ref = bet();

    expect(decideWager(context({ transaction: refundOf(ref), reference: found(ref) }))).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Credit,
      referenceTransactionId: ref.id,
    });
  });

  test('a ROLLBACK of a REFUND debits (undoes the refund)', () => {
    const refund = processed({ kind: WagerKind.Refund, money: brl('10.00') });

    expect(
      decideWager(context({ transaction: rollbackOf(refund), reference: found(refund) })),
    ).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Debit,
      referenceTransactionId: refund.id,
    });
  });

  test('a WIN without reference after a LOSS in the same round is applied', () => {
    expect(
      decideWager(context({ transaction: wager({ kind: WagerKind.Win, money: brl('25.00') }) })),
    ).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Credit,
    });
  });

  test('a WIN on a BET whose reversal was undone is applied', () => {
    const ref = bet();
    const win = wager({
      kind: WagerKind.Win,
      money: brl('50.00'),
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    expect(
      decideWager(
        context({
          transaction: win,
          reference: found(ref, { hasAnyReversal: true, hasEffectiveReversal: false }),
        }),
      ),
    ).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit, referenceTransactionId: ref.id });
  });

  test('a WIN referencing a BET does not need the same amount', () => {
    const ref = bet('10.00');
    const win = wager({
      kind: WagerKind.Win,
      money: brl('35.00'),
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    expect(decideWager(context({ transaction: win, reference: found(ref) })).type).toBe('APPLY');
  });

  test('a LOSS and a zero-amount WIN apply with no ledger direction', () => {
    expect(decideWager(context({ transaction: wager({ kind: WagerKind.Loss }) }))).toEqual({
      type: 'APPLY',
      direction: null,
    });
    expect(
      decideWager(context({ transaction: wager({ kind: WagerKind.Win, money: brl('0.00') }) })),
    ).toEqual({ type: 'APPLY', direction: null });
  });

  test('a LOSS is applied even with zero balance', () => {
    expect(
      decideWager(
        context({ transaction: wager({ kind: WagerKind.Loss }), wallet: walletWith('0.00') }),
      ).type,
    ).toBe('APPLY');
  });
});

describe('decideWager — references on kinds that do not reverse', () => {
  test('a BET carrying a reference is rejected before waiting for it', () => {
    const tx = wager({ kind: WagerKind.Bet, referenceExternalTransactionId: 'anything' });

    expect(decideWager(context({ transaction: tx, reference: { state: 'MISSING' } }))).toEqual({
      type: 'REJECT',
      code: 'INVALID_REFERENCE_KIND',
    });
  });

  test('a LOSS may reference its BET', () => {
    const ref = bet();
    const loss = wager({
      kind: WagerKind.Loss,
      money: brl('0.00'),
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    expect(decideWager(context({ transaction: loss, reference: found(ref) }))).toEqual({
      type: 'APPLY',
      direction: null,
      referenceTransactionId: ref.id,
    });
  });

  test('a LOSS referencing another round is a mismatch', () => {
    const ref = processed({ kind: WagerKind.Bet, roundId: 'round-2' });
    const loss = wager({
      kind: WagerKind.Loss,
      referenceExternalTransactionId: ref.externalTransactionId,
    });

    expect(decideWager(context({ transaction: loss, reference: found(ref) }))).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_MISMATCH',
    });
  });
});

describe('decideWager — precedence', () => {
  test('unknown provider wins over a missing wallet', () => {
    expect(decideWager(context({ transaction: wager(), provider: null, wallet: null }))).toEqual({
      type: 'REJECT',
      code: 'UNKNOWN_PROVIDER',
    });
  });

  test('a missing reference wins over insufficient balance', () => {
    const tx = wager({
      kind: WagerKind.Rollback,
      money: brl('500.00'),
      referenceExternalTransactionId: 'x',
    });

    expect(decideWager(context({ transaction: tx, reference: { state: 'MISSING' } }))).toEqual({
      type: 'PEND',
    });
  });

  test('already reversed wins over settled', () => {
    const ref = bet();

    expect(
      decideWager(
        context({
          transaction: refundOf(ref),
          reference: found(ref, { hasAnyReversal: true, hasActiveSettlingWin: true }),
        }),
      ),
    ).toEqual({ type: 'REJECT', code: 'ALREADY_REVERSED' });
  });
});
