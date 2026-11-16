// State, creation input and hashed payload shapes of a wager transaction.
import type { Money, MoneyProps } from '../../../shared/money/money';
import type { FailureCode } from './failure-code';
import type { WagerKind } from './wager-kind';
import type { WagerStatus } from './wager-status';

export interface CreateWagerProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId: string | null;
  correlationId: string;
  createdAt: Date;
  status: WagerStatus;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  processedAt: Date | null;
  observedBalance: Money | null;
  attempts: number;
  nextAttemptAt: Date | null;
  expiresAt: Date | null;
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}
