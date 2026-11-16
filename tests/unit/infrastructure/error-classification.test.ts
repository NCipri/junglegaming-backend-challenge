import { describe, expect, test } from 'bun:test';
import { classifyError } from '../../../src/infrastructure/db/error-classification';
import {
  TransientPersistenceError,
  VersionConflictError,
} from '../../../src/infrastructure/db/persistence.errors';
import { InvalidTransactionStateError } from '../../../src/modules/wagering/domain/wager.errors';
import { UnbalancedLedgerEntryError } from '../../../src/modules/wallet/domain/wallet.errors';

function pgError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`pg error ${code}`), { code, ...extra });
}

describe('classifyError — transient by default (D-045)', () => {
  test.each([
    ['40P01', 'DEADLOCK'],
    ['55P03', 'LOCK_TIMEOUT'],
    ['40001', 'SERIALIZATION_FAILURE'],
    ['57014', 'QUERY_CANCELED'],
    ['08006', 'CONNECTION_FAILURE'],
    ['08003', 'CONNECTION_FAILURE'],
    ['57P01', 'SERVER_SHUTDOWN'],
    ['57P02', 'SERVER_SHUTDOWN'],
    ['57P03', 'SERVER_SHUTDOWN'],
    ['25P03', 'IDLE_IN_TRANSACTION_TIMEOUT'],
  ])('SQLSTATE %s is TRANSIENT (%s)', (code, reason) => {
    expect(classifyError(pgError(code))).toEqual({ kind: 'TRANSIENT', reason });
  });

  test('a generic network error is TRANSIENT', () => {
    expect(classifyError(new Error('ECONNRESET'))).toEqual({
      kind: 'TRANSIENT',
      reason: 'INFRASTRUCTURE',
    });
  });

  test('a Node system error code is not mistaken for a SQLSTATE', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(classifyError(error)).toEqual({ kind: 'TRANSIENT', reason: 'INFRASTRUCTURE' });
  });

  test('a pool acquisition timeout is TRANSIENT', () => {
    expect(classifyError(new Error('timeout exceeded when trying to connect'))).toEqual({
      kind: 'TRANSIENT',
      reason: 'INFRASTRUCTURE',
    });
  });

  test('an unknown SQLSTATE outside the deterministic list is TRANSIENT', () => {
    expect(classifyError(pgError('53300'))).toEqual({
      kind: 'TRANSIENT',
      reason: 'SQLSTATE_53300',
    });
  });

  test('non-Error values are TRANSIENT', () => {
    expect(classifyError('boom')).toEqual({ kind: 'TRANSIENT', reason: 'INFRASTRUCTURE' });
    expect(classifyError(undefined)).toEqual({ kind: 'TRANSIENT', reason: 'INFRASTRUCTURE' });
  });

  test('a wallet version conflict is TRANSIENT (B-5)', () => {
    expect(classifyError(new VersionConflictError('wallets', 'w-1'))).toEqual({
      kind: 'TRANSIENT',
      reason: 'VERSION_CONFLICT',
    });
  });

  test('a ledger (wallet_id, wallet_version) collision is TRANSIENT (D-057)', () => {
    const error = pgError('23505', { constraint: 'wallet_ledger_entries_wallet_version_key' });

    expect(classifyError(error)).toEqual({ kind: 'TRANSIENT', reason: 'LEDGER_VERSION_CONFLICT' });
  });

  test('an already classified transient persistence error stays TRANSIENT', () => {
    const error = new TransientPersistenceError('LOCK_TIMEOUT', pgError('55P03'));

    expect(classifyError(error)).toEqual({ kind: 'TRANSIENT', reason: 'LOCK_TIMEOUT' });
  });
});

describe('classifyError — unique violations (D-057)', () => {
  test.each([
    'wager_transactions_provider_idempotency_key',
    'wager_transactions_provider_external_id_key',
    'wager_transactions_single_reversal',
    'wallets_player_currency_key',
  ])('23505 on %s is UNIQUE_VIOLATION with the constraint name', (constraint) => {
    expect(classifyError(pgError('23505', { constraint }))).toEqual({
      kind: 'UNIQUE_VIOLATION',
      constraint,
    });
  });

  test('23505 without a constraint name keeps an explicit placeholder', () => {
    expect(classifyError(pgError('23505'))).toEqual({
      kind: 'UNIQUE_VIOLATION',
      constraint: 'unknown',
    });
  });
});

describe('classifyError — deterministic closed list (D-056)', () => {
  test.each([
    ['23514', 'INTEGRITY_VIOLATION_23514'],
    ['23502', 'INTEGRITY_VIOLATION_23502'],
    ['23503', 'INTEGRITY_VIOLATION_23503'],
    ['22003', 'DATA_EXCEPTION_22003'],
    ['22P02', 'DATA_EXCEPTION_22P02'],
    ['P0001', 'TRIGGER_VIOLATION'],
  ])('SQLSTATE %s is DETERMINISTIC (%s)', (code, reason) => {
    expect(classifyError(pgError(code))).toEqual({ kind: 'DETERMINISTIC', reason });
  });

  test('InvalidTransactionStateError is DETERMINISTIC', () => {
    expect(classifyError(new InvalidTransactionStateError('markProcessed from PROCESSED'))).toEqual(
      { kind: 'DETERMINISTIC', reason: 'DOMAIN_INVALID_TRANSACTION_STATE' },
    );
  });

  test('UnbalancedLedgerEntryError is DETERMINISTIC', () => {
    expect(
      classifyError(new UnbalancedLedgerEntryError('before ± amount must equal after')),
    ).toEqual({ kind: 'DETERMINISTIC', reason: 'DOMAIN_LEDGER_UNBALANCED' });
  });

  test('the SQLSTATE is read through a wrapping cause', () => {
    const wrapped = new Error('query failed', { cause: pgError('22003') });

    expect(classifyError(wrapped)).toEqual({
      kind: 'DETERMINISTIC',
      reason: 'DATA_EXCEPTION_22003',
    });
  });
});
