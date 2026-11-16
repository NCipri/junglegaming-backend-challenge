// Reconciliation report: README fields plus the ledger chain diagnosis.
import type { MoneyProps } from '../../../shared/money/money';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  chainIntact: boolean;
  firstBrokenVersion: number | null;
}
