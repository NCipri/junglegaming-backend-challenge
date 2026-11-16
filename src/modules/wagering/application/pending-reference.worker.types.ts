// Settings of the pending-reference worker.
export interface PendingWorkerSettings {
  instanceId: string;
  leaseMs: number;
  pollMs: number;
  batchSize: number;
  concurrency: number;
}
