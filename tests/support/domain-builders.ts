import { Money } from '../../src/shared/money/money';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { WagerKind } from '../../src/modules/wagering/domain/wager-kind';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import type { CreateWagerProps } from '../../src/modules/wagering/domain/wager-transaction.types';

export const T0 = new Date('2026-11-15T12:00:00.000Z');

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

let seq = 0;

export function wager(overrides: Partial<CreateWagerProps> = {}): WagerTransaction {
  seq += 1;

  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerKind.Bet,
    money: brl('10.00'),
    correlationId: 'corr-1',
    createdAt: T0,
    ...overrides,
  });
}

export function processed(overrides: Partial<CreateWagerProps> = {}): WagerTransaction {
  const tx = wager(overrides);

  tx.markProcessed({ observedBalance: brl('0.00'), at: T0 });

  return tx;
}

export function walletWith(amount: string, overrides: { playerId?: string } = {}): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    currency: 'BRL',
    balance: brl(amount),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}
