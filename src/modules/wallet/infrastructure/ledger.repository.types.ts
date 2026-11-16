// Result shape of the ledger reconciliation snapshot.
export interface ReconciliationSnapshot {
  stored: string;
  walletVersion: number;
  calculated: string;
  entries: number;
  chainIntact: boolean;
  firstBrokenVersion: number | null;
}
