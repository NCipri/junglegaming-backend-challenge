// Outcome and settings of resolving a pending reference.
export type ResolveOutcome = 'PROCESSED' | 'REJECTED' | 'FAILED' | 'STILL_PENDING' | 'SKIPPED';

export interface ResolvePendingSettings {
  retryBaseMs: number;
  retryCapMs: number;
  random?: () => number;
}
