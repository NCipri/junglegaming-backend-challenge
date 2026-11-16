// Outbox message: an event committed with its transaction, published later with backoff retries (D-023, D-058).
import { computeBackoff } from '../../../shared/time/backoff';
import type { IntegrationEvent } from './integration-event';
import { InvalidMessageStateError } from './messaging.errors';
import type { OutboxMessageState } from './outbox-message.types';

const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 300_000;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }

  return value;
}

export class OutboxMessage {
  private constructor(private state: OutboxMessageState) {}

  static enqueue(event: IntegrationEvent<unknown>, partitionKey: string): OutboxMessage {
    const payload = deepFreeze(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);

    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      partitionKey,
      eventType: event.eventType,
      eventVersion: event.version,
      payload,
      occurredAt: new Date(event.occurredAt),
      attempts: 0,
      nextAttemptAt: new Date(event.occurredAt),
      publishedAt: null,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state, payload: deepFreeze({ ...state.payload }) });
  }

  get id(): string {
    return this.state.id;
  }

  get aggregateId(): string {
    return this.state.aggregateId;
  }

  get partitionKey(): string {
    return this.state.partitionKey;
  }

  get eventType(): string {
    return this.state.eventType;
  }

  get eventVersion(): number {
    return this.state.eventVersion;
  }

  get payload(): Readonly<Record<string, unknown>> {
    return this.state.payload;
  }

  get occurredAt(): Date {
    return new Date(this.state.occurredAt);
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get nextAttemptAt(): Date {
    return new Date(this.state.nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this.state.publishedAt ? new Date(this.state.publishedAt) : undefined;
  }

  isPending(): boolean {
    return this.state.publishedAt === null;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      return;
    }
    this.state = { ...this.state, publishedAt: new Date(at) };
  }

  scheduleRetry(now: Date, random: () => number): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`outbox message ${this.state.id} is already published`);
    }
    const delayMs = computeBackoff({
      attempts: this.state.attempts,
      baseMs: RETRY_BASE_MS,
      capMs: RETRY_CAP_MS,
      random,
    });

    this.state = {
      ...this.state,
      attempts: this.state.attempts + 1,
      nextAttemptAt: new Date(now.getTime() + delayMs),
    };
  }

  toState(): OutboxMessageState {
    return { ...this.state };
  }
}
