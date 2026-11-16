// Idempotency payload hash: SHA-256 of canonical JSON over business fields only.
import { canonicalJson, sha256Hex } from '../../../shared/hashing/canonical-json';
import type { WagerPayload } from './wager-transaction.types';

export function computeWagerPayloadHash(payload: WagerPayload): string {
  return sha256Hex(
    canonicalJson({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: { amount: payload.money.amount, currency: payload.money.currency },
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
    }),
  );
}
