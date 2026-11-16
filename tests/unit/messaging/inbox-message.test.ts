import { expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/modules/messaging/domain/inbox-message';
import { InvalidMessageStateError } from '../../../src/modules/messaging/domain/messaging.errors';

const at = new Date('2026-11-15T12:00:00.000Z');
const later = new Date('2026-11-15T12:00:01.000Z');

const receive = () =>
  InboxMessage.receive({
    messageId: 'msg-1',
    consumerName: 'wager-transactions',
    payloadHash: 'h1',
    at,
  });

test('is received unprocessed', () => {
  const message = receive();

  expect(message.isProcessed()).toBe(false);
  expect(message.processedAt).toBeUndefined();
  expect(message.receivedAt).toEqual(at);
});

test('is marked processed once', () => {
  const message = receive();

  message.markProcessed(later);
  expect(message.isProcessed()).toBe(true);
  expect(message.processedAt).toEqual(later);
  expect(() => message.markProcessed(later)).toThrow(InvalidMessageStateError);
});

test('tells a duplicate from a payload conflict', () => {
  const message = receive();

  expect(message.matchesPayload('h1')).toBe(true);
  expect(message.matchesPayload('h2')).toBe(false);
});

test('rehydrates persisted state', () => {
  const message = receive();

  message.markProcessed(later);
  expect(InboxMessage.rehydrate(message.toState()).toState()).toEqual(message.toState());
});

test('exposes its identity and payload hash', () => {
  const message = receive();

  expect({
    messageId: message.messageId,
    consumerName: message.consumerName,
    payloadHash: message.payloadHash,
  }).toEqual({ messageId: 'msg-1', consumerName: 'wager-transactions', payloadHash: 'h1' });
});
