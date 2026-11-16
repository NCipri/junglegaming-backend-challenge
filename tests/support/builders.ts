import { createHash } from 'node:crypto';
import { Money } from '../../src/shared/money/money';
import type { TxContext } from '../../src/infrastructure/db/tx-context';
import { WagerKind } from '../../src/modules/wagering/domain/wager-kind';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import type { CreateWagerProps } from '../../src/modules/wagering/domain/wager-transaction.types';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../src/modules/wallet/domain/wallet-ledger-entry';

export const NOW = new Date('2026-11-15T12:00:00.000Z');

export const uuid = (): string => Bun.randomUUIDv7();

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

export const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

export interface SeededWallet {
  wallet: Wallet;
  opening: WagerTransaction | null;
  entry: WalletLedgerEntry | null;
}

export async function seedWallet(
  tx: TxContext,
  p: { balance: string; currency?: string; playerId?: string; at?: Date } = { balance: '0.00' },
): Promise<SeededWallet> {
  const at = p.at ?? NOW;
  const walletId = uuid();
  const openingId = uuid();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: p.playerId ?? uuid(),
    initialBalance: money(p.balance, p.currency),
    at,
    opening: { transactionId: openingId, entryId: uuid() },
  });

  await tx.wallets.insert(wallet);
  if (!openingEntry) {
    return { wallet, opening: null, entry: null };
  }
  const opening = WagerTransaction.create({
    id: openingId,
    providerId: 'internal',
    externalTransactionId: `opening:${walletId}`,
    idempotencyKey: `opening:${walletId}`,
    payloadHash: hashOf(`opening:${walletId}`),
    walletId,
    playerId: wallet.playerId,
    roundId: null,
    gameId: null,
    kind: WagerKind.Opening,
    money: openingEntry.money,
    correlationId: `opening:${walletId}`,
    createdAt: at,
  });

  opening.markProcessed({ observedBalance: wallet.balance, at });
  await tx.transactions.insert(opening);
  await tx.ledger.insert(openingEntry);

  return { wallet, opening, entry: openingEntry };
}

export function newWager(
  wallet: Wallet,
  overrides: Partial<CreateWagerProps> = {},
): WagerTransaction {
  const id = overrides.id ?? uuid();
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${id}`;

  return WagerTransaction.create({
    id,
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `key-${externalTransactionId}`,
    payloadHash: hashOf(id),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerKind.Bet,
    money: money('10.00', wallet.currency),
    correlationId: `corr-${id}`,
    createdAt: NOW,
    ...overrides,
  });
}

export interface StartGate {
  wait(): Promise<void>;
  release(): void;
}

export function startGate(): StartGate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { wait: () => opened, release: () => open() };
}
