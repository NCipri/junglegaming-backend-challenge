// Inputs and outcome of the pure wagering decision (decideWager).
import type { Wallet } from '../../wallet/domain/wallet';
import type { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';

export type ReferenceContext =
  | { state: 'NOT_PROVIDED' }
  | { state: 'MISSING' }
  | {
      state: 'FOUND';
      transaction: WagerTransaction;
      hasAnyReversal: boolean;
      hasEffectiveReversal: boolean;
      hasActiveSettlingWin: boolean;
    };

export interface WagerContext {
  transaction: WagerTransaction;
  provider: { id: string; active: boolean } | null;
  wallet: Wallet | null;
  reference: ReferenceContext;
}

export type WagerDecision =
  | { type: 'APPLY'; direction: LedgerDirection | null; referenceTransactionId?: string }
  | { type: 'REJECT'; code: FailureCode }
  | { type: 'PEND' };
