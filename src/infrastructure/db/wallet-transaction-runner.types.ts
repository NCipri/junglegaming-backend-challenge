// Settings and per-call options of the WalletTransactionRunner.
export interface RunnerSettings {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTxTimeoutMs: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  random?: () => number;
}

export interface RunOptions {
  maxAttempts?: number;
  signal?: AbortSignal;
}
