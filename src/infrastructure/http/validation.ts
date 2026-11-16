// Strict request validation with Zod: unknown fields rejected, stable error codes for money and currency.
import type { z } from 'zod';
import { HttpProblem, invalidPayload } from './http-problem';

const IDEMPOTENCY_KEY = /^[!-~](?:[ -~]{0,253}[!-~])?$/;

function codeFor(issues: readonly z.core.$ZodIssue[]): string {
  const paths = issues.map((issue) => issue.path.map(String));

  if (paths.some((path) => path.at(-1) === 'amount')) {
    return 'INVALID_AMOUNT_FORMAT';
  }
  if (paths.some((path) => path.at(-1) === 'currency')) {
    return 'INVALID_CURRENCY';
  }

  return 'INVALID_PAYLOAD';
}

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(body)')),
    ];

    throw new HttpProblem(
      400,
      codeFor(parsed.error.issues),
      `Invalid fields: ${fields.join(', ')}`,
    );
  }

  return parsed.data;
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new HttpProblem(400, 'IDEMPOTENCY_KEY_MISSING', 'The Idempotency-Key header is required');
  }
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw invalidPayload(
      'The Idempotency-Key must be 1-255 printable ASCII characters without surrounding spaces',
    );
  }

  return value;
}
