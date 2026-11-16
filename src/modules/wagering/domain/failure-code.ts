// Stable, machine-readable failure codes carried by REJECTED and FAILED transactions.
export const FailureCode = {
  InsufficientBalance: 'INSUFFICIENT_BALANCE',
  ReversalWouldOverdraw: 'REVERSAL_WOULD_OVERDRAW',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletNotFound: 'WALLET_NOT_FOUND',
  PlayerWalletMismatch: 'PLAYER_WALLET_MISMATCH',
  UnknownProvider: 'UNKNOWN_PROVIDER',
  ReferenceRequired: 'REFERENCE_REQUIRED',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  ReferenceAmountMismatch: 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed: 'ALREADY_REVERSED',
  BetAlreadySettled: 'BET_ALREADY_SETTLED',
  OpeningNotAllowed: 'OPENING_NOT_ALLOWED',
  UnexpectedProcessingError: 'UNEXPECTED_PROCESSING_ERROR',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
