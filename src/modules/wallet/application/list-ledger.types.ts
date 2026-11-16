// Parameters and page shape of the ListLedger query.
import type { LedgerEntryView } from './wallet-view';

export interface ListLedgerParams {
  cursor?: string;
  limit?: number;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}
