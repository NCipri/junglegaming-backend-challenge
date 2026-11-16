// Payload data shapes of each integration event; money is always MoneyProps, never a number.
import type { MoneyProps } from '../../../../shared/money/money';
import type { LedgerDirection } from '../../../wallet/domain/ledger-direction';
import type { FailureCode } from '../../../wagering/domain/failure-code';
import type { WagerKind } from '../../../wagering/domain/wager-kind';
import type { WagerStatus } from '../../../wagering/domain/wager-status';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerKind;
  status: WagerStatus;
  money: MoneyProps;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  processedAt: string;
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerKind;
  status: WagerStatus;
  money: MoneyProps;
  failureCode: FailureCode;
  balance: MoneyProps | null;
  rejectedAt: string;
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerKind;
  status: WagerStatus;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  expiresAt: string | null;
}

export interface WagerTransactionFailedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerKind;
  status: WagerStatus;
  money: MoneyProps;
  failureCode: FailureCode;
  failedAt: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
