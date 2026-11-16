import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/shared/money/money.errors';
import { Money } from '../../../src/shared/money/money';
import { LedgerDirection } from '../../../src/modules/wallet/domain/ledger-direction';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import {
  InsufficientBalanceError,
  InvalidWalletOpeningError,
  UnbalancedLedgerEntryError,
} from '../../../src/modules/wallet/domain/wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const t0 = new Date('2026-11-15T12:00:00.000Z');
const t1 = new Date('2026-11-15T12:05:00.000Z');

function openWith(amount: string) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    at: t0,
    opening: { transactionId: 'opening-tx', entryId: 'opening-entry' },
  });
}

describe('Wallet.open', () => {
  test('opens with the initial balance at version 1 and an opening credit entry', () => {
    const { wallet, openingEntry } = openWith('1000.00');

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).not.toBeNull();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
    expect(openingEntry?.transactionId).toBe('opening-tx');
    expect(openingEntry?.id).toBe('opening-entry');
  });

  test('opens with zero balance and no opening entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('0.00'),
      at: t0,
    });

    expect(openingEntry).toBeNull();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('requires the opening transaction when the initial balance is positive', () => {
    expect(() =>
      Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('10.00'), at: t0 }),
    ).toThrow(InvalidWalletOpeningError);
  });

  test('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('0.00').subtract(brl('1.00')),
        at: t0,
      }),
    ).toThrow(InvalidWalletOpeningError);
  });
});

describe('Wallet.debit', () => {
  test('debits, bumps the version and returns the matching ledger entry', () => {
    const { wallet } = openWith('100.00');
    const entry = wallet.debit({
      money: brl('80.00'),
      transactionId: 'bet-1',
      entryId: 'e-1',
      at: t1,
    });

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('bet-1');
  });

  test('rejects an overdraft and leaves the state untouched', () => {
    const { wallet } = openWith('100.00');

    wallet.debit({ money: brl('80.00'), transactionId: 'bet-1', entryId: 'e-1', at: t1 });
    expect(() =>
      wallet.debit({ money: brl('80.00'), transactionId: 'bet-2', entryId: 'e-2', at: t1 }),
    ).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('allows debiting the exact balance down to zero', () => {
    const { wallet } = openWith('80.00');

    wallet.debit({ money: brl('80.00'), transactionId: 'bet-1', entryId: 'e-1', at: t1 });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects a zero amount and leaves the state untouched', () => {
    const { wallet } = openWith('100.00');

    expect(() =>
      wallet.debit({ money: brl('0.00'), transactionId: 'bet-1', entryId: 'e-1', at: t1 }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(t0);
  });
});

describe('Wallet.credit', () => {
  test('credits, bumps the version and returns the matching ledger entry', () => {
    const { wallet } = openWith('100.00');
    const entry = wallet.credit({
      money: brl('50.00'),
      transactionId: 'win-1',
      entryId: 'e-1',
      at: t1,
    });

    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.walletVersion).toBe(2);
  });

  test('rejects another currency and leaves the state untouched', () => {
    const { wallet } = openWith('100.00');

    expect(() =>
      wallet.credit({ money: usd('10.00'), transactionId: 'win-1', entryId: 'e-1', at: t1 }),
    ).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.canDebit', () => {
  test('tells whether a debit fits the balance', () => {
    const { wallet } = openWith('100.00');

    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
  });

  test('rejects another currency', () => {
    const { wallet } = openWith('100.00');

    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet.rehydrate', () => {
  test('round-trips every field through toState', () => {
    const { wallet } = openWith('100.00');

    wallet.debit({ money: brl('30.00'), transactionId: 'bet-1', entryId: 'e-1', at: t1 });
    const copy = Wallet.rehydrate(wallet.toState());

    expect(copy.toState()).toEqual(wallet.toState());
    expect(copy.id).toBe('wallet-1');
    expect(copy.playerId).toBe('player-1');
    expect(copy.createdAt).toEqual(t0);
    expect(copy.updatedAt).toEqual(t1);
    expect(copy.version).toBe(2);
  });

  test('does not share mutable state with the source', () => {
    const { wallet } = openWith('100.00');
    const copy = Wallet.rehydrate(wallet.toState());

    copy.debit({ money: brl('10.00'), transactionId: 'bet-1', entryId: 'e-1', at: t1 });
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });
});
