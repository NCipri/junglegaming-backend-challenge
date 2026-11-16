// OpenWallet use case: wallet, OPENING transaction, CREDIT entry and events in one SQL transaction.
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import { sha256Hex, canonicalJson } from '../../../shared/hashing/canonical-json';
import type { IdGenerator } from '../../../shared/ids/id-generator';
import { Money } from '../../../shared/money/money';
import type { Clock } from '../../../shared/time/clock';
import type { EventFactory } from '../../messaging/domain/event-factory';
import { WagerKind } from '../../wagering/domain/wager-kind';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { OpenWalletCommand, OpenWalletResult } from './open-wallet.types';
import { toWalletView } from './wallet-view';

export const INTERNAL_PROVIDER = 'internal';

export class OpenWallet {
  constructor(
    private readonly runner: WalletTransactionRunner,
    private readonly events: EventFactory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  execute(cmd: OpenWalletCommand): Promise<OpenWalletResult> {
    const initialBalance = Money.from(cmd.initialBalance);
    const walletId = this.ids.next();

    return this.runner.run(async (tx) => {
      const existing = await tx.wallets.findByPlayerAndCurrency(
        cmd.playerId,
        initialBalance.currency,
      );

      if (existing) {
        return { type: 'ALREADY_EXISTS', walletId: existing.id };
      }
      const at = this.clock.now();
      const openingId = this.ids.next();
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: cmd.playerId,
        initialBalance,
        at,
        opening: { transactionId: openingId, entryId: this.ids.next() },
      });

      await tx.wallets.insert(wallet);
      if (openingEntry) {
        const externalId = `opening:${walletId}`;
        const opening = WagerTransaction.create({
          id: openingId,
          providerId: INTERNAL_PROVIDER,
          externalTransactionId: externalId,
          idempotencyKey: externalId,
          payloadHash: sha256Hex(
            canonicalJson({ walletId, playerId: cmd.playerId, money: initialBalance.toJSON() }),
          ),
          walletId,
          playerId: cmd.playerId,
          roundId: null,
          gameId: null,
          kind: WagerKind.Opening,
          money: initialBalance,
          correlationId: cmd.correlationId,
          createdAt: at,
        });

        opening.markProcessed({ observedBalance: wallet.balance, at });
        await tx.transactions.insert(opening);
        await tx.ledger.insert(openingEntry);
        await tx.outbox.insertMany(
          this.events.forProcessed(opening, openingEntry, { correlationId: cmd.correlationId }),
        );
      }

      return { type: 'CREATED', wallet: toWalletView(wallet) };
    });
  }
}
