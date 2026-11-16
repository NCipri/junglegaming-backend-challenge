// Settings of the outbox relay.
export interface OutboxRelaySettings {
  instanceId: string;
  leaseMs: number;
  pollMs: number;
  batchSize: number;
  retryBaseMs: number;
  retryCapMs: number;
  random?: () => number;
}
