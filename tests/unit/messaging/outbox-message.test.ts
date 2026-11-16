import { expect, test } from 'bun:test';
import { EventFactory } from '../../../src/modules/messaging/domain/event-factory';
import { InvalidMessageStateError } from '../../../src/modules/messaging/domain/messaging.errors';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { brl, T0, wager } from '../../support/domain-builders';

const factory = new EventFactory({ next: () => 'event-1' }, { now: () => T0 });

function message(): OutboxMessage {
  const tx = wager();

  tx.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('1.00'), at: T0 });
  const [first] = factory.forRejected(tx, { correlationId: 'corr-1' });

  if (!first) {
    throw new Error('expected one message');
  }

  return first;
}

const seconds = (s: number) => new Date(T0.getTime() + s * 1000);

test('is enqueued pending, due immediately, with no attempts', () => {
  const m = message();

  expect(m.id).toBe('event-1');
  expect(m.attempts).toBe(0);
  expect(m.isPending()).toBe(true);
  expect(m.nextAttemptAt).toEqual(T0);
  expect(m.isDue(T0)).toBe(true);
  expect(m.isDue(seconds(-1))).toBe(false);
});

test('scheduleRetry uses the attempts made so far, then increments them', () => {
  const m = message();

  for (let i = 0; i < 3; i++) {
    m.scheduleRetry(T0, () => 0.5);
  }
  m.scheduleRetry(T0, () => 0.5);
  expect(m.attempts).toBe(4);
  expect(m.nextAttemptAt).toEqual(seconds(8));
  expect(m.isDue(seconds(7))).toBe(false);
});

test('the retry delay never exceeds five minutes', () => {
  const m = message();

  for (let i = 0; i < 20; i++) {
    m.scheduleRetry(T0, () => 1);
  }
  m.scheduleRetry(T0, () => 1);
  expect(m.nextAttemptAt).toEqual(seconds(300));
});

test('markPublished stops it from being pending and keeps the first publication time', () => {
  const m = message();

  m.markPublished(seconds(1));
  m.markPublished(seconds(2));
  expect(m.isPending()).toBe(false);
  expect(m.isDue(seconds(10))).toBe(false);
  expect(m.publishedAt).toEqual(seconds(1));
});

test('a published message cannot be scheduled again', () => {
  const m = message();

  m.markPublished(seconds(1));
  expect(() => m.scheduleRetry(seconds(2), () => 0.5)).toThrow(InvalidMessageStateError);
});

test('rehydrates persisted state', () => {
  const m = message();

  m.scheduleRetry(T0, () => 0.5);
  expect(OutboxMessage.rehydrate(m.toState()).toState()).toEqual(m.toState());
});

test('exposes the aggregate and the occurrence time of its event', () => {
  const m = message();

  expect(m.aggregateId).toBe((m.payload as { aggregateId: string }).aggregateId);
  expect(m.occurredAt).toEqual(T0);
});
