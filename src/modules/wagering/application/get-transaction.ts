// GetTransaction query: by id or by provider external id; a provider never sees another provider's transaction.
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { TransactionDetails, Viewer } from './get-transaction.types';

function toDetails(tx: WagerTransaction): TransactionDetails {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balance: tx.observedBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

function visible(tx: WagerTransaction | null, viewer: Viewer): TransactionDetails | null {
  if (!tx) {
    return null;
  }
  if (viewer.role === 'provider' && viewer.providerId !== tx.providerId) {
    return null;
  }

  return toDetails(tx);
}

export class GetTransaction {
  constructor(private readonly runner: WalletTransactionRunner) {}

  async byId(id: string, viewer: Viewer): Promise<TransactionDetails | null> {
    return visible(await this.runner.read((tx) => tx.transactions.findById(id)), viewer);
  }

  async byExternalId(
    providerId: string,
    externalId: string,
    viewer: Viewer,
  ): Promise<TransactionDetails | null> {
    return visible(
      await this.runner.read((tx) => tx.transactions.findByExternalId(providerId, externalId)),
      viewer,
    );
  }
}
