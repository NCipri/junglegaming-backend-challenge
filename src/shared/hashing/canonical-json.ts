// Canonical JSON (sorted keys, no whitespace, null/undefined members dropped) and SHA-256.
import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== null && member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => [key, canonicalize(member)] as const);

    return Object.fromEntries(entries);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Canonical JSON cannot represent non-finite numbers');
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
