// Command and result of the OpenWallet use case.
import type { MoneyProps } from '../../../shared/money/money';
import type { WalletView } from './wallet-view';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export type OpenWalletResult =
  { type: 'CREATED'; wallet: WalletView } | { type: 'ALREADY_EXISTS'; walletId: string };
