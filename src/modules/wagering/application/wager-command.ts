// Wager command shared by the HTTP and SQS channels, plus the channel descriptor.
import type { MoneyProps } from '../../../shared/money/money';
import type { WagerKind } from '../domain/wager-kind';

export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  idempotencyKey: string;
  correlationId: string;
}

export type WagerChannel =
  { type: 'HTTP' } | { type: 'SQS'; consumerName: string; messageId: string; messageHash: string };
