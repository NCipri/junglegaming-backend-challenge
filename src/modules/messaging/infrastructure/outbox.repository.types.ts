// Inputs and results of the outbox repository claim.
export interface ClaimOutboxParams {
  instanceId: string;
  limit: number;
  leaseMs: number;
  now: Date;
}

export interface ClaimedOutboxMessage {
  id: string;
  partitionKey: string;
  eventType: string;
  eventVersion: number;
  payloadText: string;
  attempts: number;
}
