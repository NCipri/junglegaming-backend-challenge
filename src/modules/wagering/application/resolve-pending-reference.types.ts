// Outcome and settings of resolving a pending reference.
export type ResolveOutcome = 'PROCESSED' | 'REJECTED' | 'STILL_PENDING' | 'SKIPPED';

export interface ResolvePendingSettings {
  retryBaseMs: number;
  retryCapMs: number;
  random?: () => number;
}
