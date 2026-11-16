// Outcome of processing a wager command and the transaction view built only from recorded data.
import type { MoneyProps } from '../../../shared/money/money';
import type { FailureCode } from '../domain/failure-code';
import type { WagerStatus } from '../domain/wager-status';
import type { WagerTransaction } from '../domain/wager-transaction';

export interface TransactionView {
  transactionId: string;
  status: WagerStatus;
  failureCode?: FailureCode;
  balance: MoneyProps | null;
}

export type WagerResult =
  | { type: 'RESULT'; view: TransactionView; replay: boolean }
  | { type: 'IDEMPOTENCY_CONFLICT' }
  | { type: 'EXTERNAL_ID_CONFLICT' }
  | { type: 'INBOX_DUPLICATE' }
  | { type: 'INBOX_PAYLOAD_CONFLICT' };

export function toTransactionView(tx: WagerTransaction): TransactionView {
  const view: TransactionView = {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance?.toJSON() ?? null,
  };

  if (tx.failureCode !== undefined) {
    view.failureCode = tx.failureCode;
  }

  return view;
}
