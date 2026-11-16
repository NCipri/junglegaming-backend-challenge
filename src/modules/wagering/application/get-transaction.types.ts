// Viewer of a transaction query and the transaction details it may see.
import type { MoneyProps } from '../../../shared/money/money';
import type { FailureCode } from '../domain/failure-code';
import type { WagerKind } from '../domain/wager-kind';
import type { WagerStatus } from '../domain/wager-status';

export type Viewer = { role: 'operator' } | { role: 'provider'; providerId: string };

export interface TransactionDetails {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerKind;
  money: MoneyProps;
  status: WagerStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}
