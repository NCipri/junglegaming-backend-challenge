// Settings and report of the readiness probe.
export interface ReadinessSettings {
  queueUrl: string;
  timeoutMs: number;
}

export interface ReadinessReport {
  ready: boolean;
  checks: { database: 'up' | 'down'; sqs: 'up' | 'down'; shuttingDown: boolean };
}
