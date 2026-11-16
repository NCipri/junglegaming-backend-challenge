// Settings and per-call context of the WagerProcessor.
import type { Wallet } from '../../wallet/domain/wallet';

export interface WagerProcessorSettings {
  pendingTtlMs: number;
  pendingFirstRetryMs: number;
}

export interface ProcessContext {
  wallet: Wallet | null;
  correlationId: string;
  causationId?: string;
}
