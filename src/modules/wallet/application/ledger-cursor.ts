// Opaque, stable ledger cursor: base64url of the last wallet version seen.
import { DomainError } from '../../../shared/errors/domain-error';

const CURSOR = /^v:([1-9]\d{0,9})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('Invalid ledger cursor');
  }
}

export function encodeCursor(version: number): string {
  return Buffer.from(`v:${version}`).toString('base64url');
}

export function decodeCursor(cursor: string): number {
  if (!BASE64URL.test(cursor)) {
    throw new InvalidCursorError();
  }
  const match = CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const version = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;

  if (!Number.isSafeInteger(version)) {
    throw new InvalidCursorError();
  }

  return version;
}
