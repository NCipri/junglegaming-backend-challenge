// Error classification: closed deterministic list, unique violations apart, the rest transient.
import { DomainError } from '../../shared/errors/domain-error';
import { TransientPersistenceError, VersionConflictError } from './persistence.errors';

export type ErrorClass =
  | { kind: 'TRANSIENT'; reason: string }
  | { kind: 'UNIQUE_VIOLATION'; constraint: string }
  | { kind: 'DETERMINISTIC'; reason: string };

export const LEDGER_VERSION_CONSTRAINT = 'wallet_ledger_entries_wallet_version_key';

const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

const TRANSIENT_SQLSTATES: Readonly<Record<string, string>> = {
  '40P01': 'DEADLOCK',
  '55P03': 'LOCK_TIMEOUT',
  '40001': 'SERIALIZATION_FAILURE',
  '57014': 'QUERY_CANCELED',
  '57P01': 'SERVER_SHUTDOWN',
  '57P02': 'SERVER_SHUTDOWN',
  '57P03': 'SERVER_SHUTDOWN',
  '25P03': 'IDLE_IN_TRANSACTION_TIMEOUT',
};

function sqlStateOf(error: Error): string | null {
  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' && SQLSTATE.test(code) ? code : null;
}

function constraintOf(error: Error): string {
  const constraint = (error as { constraint?: unknown }).constraint;

  return typeof constraint === 'string' && constraint.length > 0 ? constraint : 'unknown';
}

function classifySqlState(error: Error, state: string): ErrorClass {
  if (state === '23505') {
    const constraint = constraintOf(error);

    return constraint === LEDGER_VERSION_CONSTRAINT
      ? { kind: 'TRANSIENT', reason: 'LEDGER_VERSION_CONFLICT' }
      : { kind: 'UNIQUE_VIOLATION', constraint };
  }
  if (state === 'P0001') {
    return { kind: 'DETERMINISTIC', reason: 'TRIGGER_VIOLATION' };
  }
  if (state.startsWith('22')) {
    return { kind: 'DETERMINISTIC', reason: `DATA_EXCEPTION_${state}` };
  }
  if (state.startsWith('23')) {
    return { kind: 'DETERMINISTIC', reason: `INTEGRITY_VIOLATION_${state}` };
  }
  if (state.startsWith('08')) {
    return { kind: 'TRANSIENT', reason: 'CONNECTION_FAILURE' };
  }

  return { kind: 'TRANSIENT', reason: TRANSIENT_SQLSTATES[state] ?? `SQLSTATE_${state}` };
}

export function classifyError(error: unknown): ErrorClass {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (current instanceof TransientPersistenceError) {
      return { kind: 'TRANSIENT', reason: current.reason };
    }
    if (current instanceof VersionConflictError) {
      return { kind: 'TRANSIENT', reason: 'VERSION_CONFLICT' };
    }
    if (current instanceof DomainError) {
      return { kind: 'DETERMINISTIC', reason: `DOMAIN_${current.code}` };
    }
    const state = sqlStateOf(current);

    if (state) {
      return classifySqlState(current, state);
    }
    current = current.cause;
  }

  return { kind: 'TRANSIENT', reason: 'INFRASTRUCTURE' };
}
