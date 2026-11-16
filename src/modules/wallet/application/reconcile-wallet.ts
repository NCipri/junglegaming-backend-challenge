// ReconcileWallet: compares the stored balance with the ledger in one snapshot; divergence is reported, never fixed.
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import { Money } from '../../../shared/money/money';
import type { AppLogger } from '../../observability/logger.port';
import type { MetricsPort } from '../../observability/metrics.port';
import type { ReconciliationReport } from './reconcile-wallet.types';

function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}

export class ReconcileWallet {
  constructor(
    private readonly runner: WalletTransactionRunner,
    private readonly metrics: MetricsPort,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport | null> {
    const found = await this.runner.read(async (tx) => {
      const wallet = await tx.wallets.findById(walletId);
      const snapshot = wallet ? await tx.ledger.reconciliationSnapshot(walletId) : null;

      return wallet && snapshot ? { currency: wallet.currency, snapshot } : null;
    });

    if (!found) {
      return null;
    }
    const { currency, snapshot } = found;
    const stored = signedMoney(snapshot.stored, currency);
    const calculated = signedMoney(snapshot.calculated, currency);
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero() && snapshot.chainIntact;
    const report: ReconciliationReport = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.entries,
      chainIntact: snapshot.chainIntact,
      firstBrokenVersion: snapshot.firstBrokenVersion,
    };

    if (!consistent) {
      this.metrics.increment('reconciliation_divergence_total');
      this.logger.error(
        {
          walletId,
          chainIntact: snapshot.chainIntact,
          firstBrokenVersion: snapshot.firstBrokenVersion,
          checkedEntries: snapshot.entries,
        },
        'Wallet reconciliation divergence',
      );
    }

    return report;
  }
}
