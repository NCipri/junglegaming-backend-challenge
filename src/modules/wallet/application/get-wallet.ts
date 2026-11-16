// GetWallet query: current balance and version, read without locks.
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import { toWalletView, type WalletView } from './wallet-view';

export class GetWallet {
  constructor(private readonly runner: WalletTransactionRunner) {}

  async execute(walletId: string): Promise<WalletView | null> {
    const wallet = await this.runner.read((tx) => tx.wallets.findById(walletId));

    return wallet ? toWalletView(wallet) : null;
  }
}
