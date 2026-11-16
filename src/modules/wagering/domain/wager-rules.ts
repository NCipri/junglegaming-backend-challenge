// Pure wagering decision: evaluates the business rules in a fixed order; first violation wins.
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import { FailureCode } from './failure-code';
import { WagerKind } from './wager-kind';
import { WagerStatus } from './wager-status';
import type { WagerTransaction } from './wager-transaction';
import type { ReferenceContext, WagerContext, WagerDecision } from './wager-rules.types';

type FoundReference = Extract<ReferenceContext, { state: 'FOUND' }>;

const ACCEPTED_REFERENCE_KINDS: Record<WagerKind, ReadonlySet<WagerKind>> = {
  [WagerKind.Opening]: new Set(),
  [WagerKind.Bet]: new Set(),
  [WagerKind.Win]: new Set([WagerKind.Bet]),
  [WagerKind.Loss]: new Set([WagerKind.Bet]),
  [WagerKind.Refund]: new Set([WagerKind.Bet]),
  [WagerKind.Rollback]: new Set([WagerKind.Bet, WagerKind.Win, WagerKind.Refund]),
};

const reject = (code: FailureCode): WagerDecision => ({ type: 'REJECT', code });

export function decideWager(ctx: WagerContext): WagerDecision {
  const tx = ctx.transaction;

  if (tx.kind === WagerKind.Opening) {
    return reject(FailureCode.OpeningNotAllowed);
  }
  if (!ctx.provider?.active) {
    return reject(FailureCode.UnknownProvider);
  }
  if (!ctx.wallet) {
    return reject(FailureCode.WalletNotFound);
  }
  if (ctx.wallet.playerId !== tx.playerId) {
    return reject(FailureCode.PlayerWalletMismatch);
  }
  if (ctx.wallet.currency !== tx.money.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  const referenceIssue = checkReferencePresence(tx, ctx.reference);

  if (referenceIssue) {
    return referenceIssue;
  }

  const reference = ctx.reference.state === 'FOUND' ? ctx.reference : null;

  if (reference) {
    const violation = checkReference(tx, reference);

    if (violation) {
      return violation;
    }
  }

  return applyOrRejectOnBalance(tx, ctx.wallet, reference?.transaction);
}

function checkReferencePresence(
  tx: WagerTransaction,
  reference: ReferenceContext,
): WagerDecision | null {
  const accepts = ACCEPTED_REFERENCE_KINDS[tx.kind].size > 0;

  if (tx.referenceExternalTransactionId !== undefined && !accepts) {
    return reject(FailureCode.InvalidReferenceKind);
  }
  if (tx.requiresReference() && tx.referenceExternalTransactionId === undefined) {
    return reject(FailureCode.ReferenceRequired);
  }
  if (reference.state === 'MISSING') {
    return { type: 'PEND' };
  }
  if (
    reference.state === 'FOUND' &&
    reference.transaction.status === WagerStatus.PendingReference
  ) {
    return { type: 'PEND' };
  }

  return null;
}

function checkReference(tx: WagerTransaction, reference: FoundReference): WagerDecision | null {
  const ref = reference.transaction;

  if (ref.status !== WagerStatus.Processed) {
    return reject(FailureCode.ReferenceNotProcessed);
  }
  if (!ACCEPTED_REFERENCE_KINDS[tx.kind].has(ref.kind)) {
    return reject(FailureCode.InvalidReferenceKind);
  }
  if (!belongsToSameContext(tx, ref)) {
    return reject(FailureCode.ReferenceMismatch);
  }
  if (tx.requiresReference() && !tx.money.equals(ref.money)) {
    return reject(FailureCode.ReferenceAmountMismatch);
  }
  if (tx.requiresReference() && reference.hasAnyReversal) {
    return reject(FailureCode.AlreadyReversed);
  }
  if (tx.kind === WagerKind.Win && reference.hasEffectiveReversal) {
    return reject(FailureCode.AlreadyReversed);
  }
  if (tx.requiresReference() && ref.kind === WagerKind.Bet && reference.hasActiveSettlingWin) {
    return reject(FailureCode.BetAlreadySettled);
  }

  return null;
}

function belongsToSameContext(tx: WagerTransaction, ref: WagerTransaction): boolean {
  return (
    ref.providerId === tx.providerId &&
    ref.playerId === tx.playerId &&
    ref.walletId === tx.walletId &&
    ref.roundId === tx.roundId &&
    ref.money.currency === tx.money.currency
  );
}

function applyOrRejectOnBalance(
  tx: WagerTransaction,
  wallet: Wallet,
  reference: WagerTransaction | undefined,
): WagerDecision {
  const direction = tx.ledgerDirectionFor(reference);

  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(
      tx.kind === WagerKind.Rollback
        ? FailureCode.ReversalWouldOverdraw
        : FailureCode.InsufficientBalance,
    );
  }

  return reference
    ? { type: 'APPLY', direction, referenceTransactionId: reference.id }
    : { type: 'APPLY', direction };
}
