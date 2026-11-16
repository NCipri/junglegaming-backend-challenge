// WagerTransaction entity: explicit state machine where PROCESSED, REJECTED and FAILED are terminal.
import { Money } from '../../../shared/money/money';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { FailureCode } from './failure-code';
import { WagerKind } from './wager-kind';
import { WagerStatus } from './wager-status';
import { InvalidTransactionStateError, InvalidWagerAmountError } from './wager.errors';
import type { CreateWagerProps, WagerTransactionState } from './wager-transaction.types';

const ZERO_FORBIDDEN = new Set([WagerKind.Bet, WagerKind.Refund, WagerKind.Opening]);
const REVERSALS = new Set([WagerKind.Refund, WagerKind.Rollback]);
const TERMINAL = new Set([WagerStatus.Processed, WagerStatus.Rejected, WagerStatus.Failed]);

export class WagerTransaction {
  private constructor(private state: WagerTransactionState) {}

  static create(props: CreateWagerProps): WagerTransaction {
    if (props.money.isNegative()) {
      throw new InvalidWagerAmountError('INVALID_AMOUNT_FORMAT', 'amount must not be negative');
    }
    if (props.money.isZero() && ZERO_FORBIDDEN.has(props.kind)) {
      throw new InvalidWagerAmountError(
        'INVALID_AMOUNT_ZERO',
        `${props.kind} requires a positive amount`,
      );
    }

    return new WagerTransaction({
      ...props,
      createdAt: new Date(props.createdAt),
      referenceExternalTransactionId: props.referenceExternalTransactionId ?? null,
      status: WagerStatus.Pending,
      referenceTransactionId: null,
      failureCode: null,
      processedAt: null,
      observedBalance: null,
      attempts: 0,
      nextAttemptAt: null,
      expiresAt: null,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id(): string {
    return this.state.id;
  }

  get providerId(): string {
    return this.state.providerId;
  }

  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }

  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get walletId(): string {
    return this.state.walletId;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get roundId(): string | null {
    return this.state.roundId;
  }

  get gameId(): string | null {
    return this.state.gameId;
  }

  get kind(): WagerKind {
    return this.state.kind;
  }

  get money(): Money {
    return this.state.money;
  }

  get referenceExternalTransactionId(): string | undefined {
    return this.state.referenceExternalTransactionId ?? undefined;
  }

  get correlationId(): string {
    return this.state.correlationId;
  }

  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }

  get status(): WagerStatus {
    return this.state.status;
  }

  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId ?? undefined;
  }

  get failureCode(): FailureCode | undefined {
    return this.state.failureCode ?? undefined;
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt ? new Date(this.state.processedAt) : undefined;
  }

  get observedBalance(): Money | null {
    return this.state.observedBalance;
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt ? new Date(this.state.nextAttemptAt) : undefined;
  }

  get expiresAt(): Date | undefined {
    return this.state.expiresAt ? new Date(this.state.expiresAt) : undefined;
  }

  markProcessed(p: { referenceTransactionId?: string; observedBalance: Money; at: Date }): void {
    this.assertResolvable('markProcessed');
    this.state = {
      ...this.state,
      status: WagerStatus.Processed,
      referenceTransactionId: p.referenceTransactionId ?? null,
      observedBalance: p.observedBalance,
      processedAt: new Date(p.at),
      nextAttemptAt: null,
    };
  }

  markPendingReference(p: {
    observedBalance: Money | null;
    nextAttemptAt: Date;
    expiresAt: Date;
  }): void {
    if (this.state.status !== WagerStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference from ${this.state.status}`);
    }
    this.state = {
      ...this.state,
      status: WagerStatus.PendingReference,
      observedBalance: p.observedBalance,
      nextAttemptAt: new Date(p.nextAttemptAt),
      expiresAt: new Date(p.expiresAt),
    };
  }

  reject(p: { code: FailureCode; observedBalance: Money | null; at: Date }): void {
    this.assertResolvable('reject');
    this.state = {
      ...this.state,
      status: WagerStatus.Rejected,
      failureCode: p.code,
      observedBalance: p.observedBalance,
      processedAt: new Date(p.at),
      nextAttemptAt: null,
    };
  }

  fail(p: { code: 'UNEXPECTED_PROCESSING_ERROR'; at: Date }): void {
    this.assertResolvable('fail');
    this.state = {
      ...this.state,
      status: WagerStatus.Failed,
      failureCode: p.code,
      processedAt: new Date(p.at),
      nextAttemptAt: null,
    };
  }

  scheduleRetry(nextAttemptAt: Date): void {
    if (this.state.status !== WagerStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleRetry from ${this.state.status}`);
    }
    this.state = {
      ...this.state,
      attempts: this.state.attempts + 1,
      nextAttemptAt: new Date(nextAttemptAt),
    };
  }

  isTerminal(): boolean {
    return TERMINAL.has(this.state.status);
  }

  affectsBalance(): boolean {
    return this.state.kind !== WagerKind.Loss && !this.state.money.isZero();
  }

  requiresReference(): boolean {
    return REVERSALS.has(this.state.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    if (!this.affectsBalance()) {
      return null;
    }
    if (this.state.kind === WagerKind.Bet) {
      return LedgerDirection.Debit;
    }
    if (this.state.kind !== WagerKind.Rollback) {
      return LedgerDirection.Credit;
    }
    if (!reference) {
      throw new InvalidTransactionStateError(
        'a ROLLBACK needs its reference to know its direction',
      );
    }

    return reference.ledgerDirectionFor() === LedgerDirection.Debit
      ? LedgerDirection.Credit
      : LedgerDirection.Debit;
  }

  toState(): WagerTransactionState {
    return { ...this.state };
  }

  private assertResolvable(transition: string): void {
    if (
      this.state.status !== WagerStatus.Pending &&
      this.state.status !== WagerStatus.PendingReference
    ) {
      throw new InvalidTransactionStateError(`${transition} from ${this.state.status}`);
    }
  }
}
