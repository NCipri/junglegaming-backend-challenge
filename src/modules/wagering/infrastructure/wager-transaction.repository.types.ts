// Inputs and results of the wager transaction repository queries.
export interface ReferenceFacts {
  hasAnyReversal: boolean;
  hasEffectiveReversal: boolean;
  hasActiveSettlingWin: boolean;
}

export interface ClaimPendingParams {
  instanceId: string;
  limit: number;
  leaseMs: number;
  now: Date;
}
