import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/money/money';
import { LedgerDirection } from '../../../src/modules/wallet/domain/ledger-direction';
import { WalletLedgerEntry } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { UnbalancedLedgerEntryError } from '../../../src/modules/wallet/domain/wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-15T12:00:00.000Z');

const base = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  walletVersion: 2,
  createdAt: at,
};

describe('WalletLedgerEntry.create', () => {
  test('creates a balanced debit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(entry.walletVersion).toBe(2);
  });

  test('creates a balanced credit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects arithmetic that does not balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejects a zero amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('100.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('80.00'),
        balanceBefore: brl('20.00'),
        balanceAfter: brl('20.00').subtract(brl('80.00')),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejects a wallet version below 1', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        walletVersion: 0,
        direction: LedgerDirection.Credit,
        money: brl('1.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('carries the stable LEDGER_UNBALANCED code', () => {
    try {
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('1.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      });
    } catch (error) {
      expect((error as UnbalancedLedgerEntryError).code).toBe('LEDGER_UNBALANCED');
      return;
    }
    throw new Error('expected an error');
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('rebuilds persisted state without re-validating', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('80.00'),
    });
    expect(entry.isBalanced()).toBe(false);
    expect(entry.id).toBe('entry-1');
  });

  test('exposes no mutators: every field is read-only at runtime', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
