import { describe, expect, test } from 'bun:test';
import { WagerMessageHandler } from '../../../src/modules/wagering/interface/wager-message.handler';

const PLAYER = '0192F28F-5DC0-7D58-BDB2-814AD6A0F4A1';
const WALLET = '0192F291-27DD-7D3F-8071-5F8685DEEF37';

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'msg-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-16T12:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      idempotencyKey: 'provider-a:tx-1',
      playerId: PLAYER,
      walletId: WALLET,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    },
  });
}

describe('WagerMessageHandler', () => {
  test('normalizes upper-case UUIDs, so the hash and the command match the lower-case form', () => {
    const handler = new WagerMessageHandler();
    const upper = handler.parse(body());
    const lower = handler.parse(
      body({ playerId: PLAYER.toLowerCase(), walletId: WALLET.toLowerCase() }),
    );

    expect(upper.command.playerId).toBe(PLAYER.toLowerCase());
    expect(upper.command.walletId).toBe(WALLET.toLowerCase());
    expect(upper.messageHash).toBe(lower.messageHash);
  });
});
