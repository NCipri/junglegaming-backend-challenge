import { expect, test } from 'bun:test';
import { computeWagerPayloadHash } from '../../../src/modules/wagering/domain/payload-hash';
import type { WagerPayload } from '../../../src/modules/wagering/domain/wager-transaction.types';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

test('is a 64-character lowercase hex SHA-256', () => {
  expect(computeWagerPayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
});

test('ignores key order', () => {
  const reordered = {
    money: { currency: 'BRL', amount: '25.00' },
    kind: 'BET',
    gameId: 'fortune-chimp',
    roundId: 'round-987',
    walletId: payload.walletId,
    playerId: payload.playerId,
    externalTransactionId: 'transaction-123',
    providerId: 'provider-a',
  } as WagerPayload;

  expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(payload));
});

test('treats a null reference like an absent one', () => {
  expect(computeWagerPayloadHash({ ...payload, referenceExternalTransactionId: null })).toBe(
    computeWagerPayloadHash(payload),
  );
});

test('changes when a business field changes', () => {
  const other = { ...payload, money: { amount: '25.01', currency: 'BRL' } };

  expect(computeWagerPayloadHash(other)).not.toBe(computeWagerPayloadHash(payload));
  expect(computeWagerPayloadHash({ ...payload, referenceExternalTransactionId: 'x' })).not.toBe(
    computeWagerPayloadHash(payload),
  );
});

test('ignores transport fields such as the idempotency key', () => {
  const withTransport = { ...payload, idempotencyKey: 'provider-a:other', messageId: 'm-1' };

  expect(computeWagerPayloadHash(withTransport as WagerPayload)).toBe(
    computeWagerPayloadHash(payload),
  );
});
