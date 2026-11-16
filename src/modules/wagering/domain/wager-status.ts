// Lifecycle statuses of a wager transaction; PROCESSED, REJECTED and FAILED are terminal.
export enum WagerStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}
