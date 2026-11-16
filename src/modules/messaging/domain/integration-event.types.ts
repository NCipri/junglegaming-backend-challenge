// Envelope, metadata and context shapes shared by every integration event.
export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface EventMeta extends EventContext {
  eventId: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventMeta {
  aggregateId: string;
  data: T;
}

export interface EventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}
