// Single status mapping: wager results to 200/202/409/422 and any thrown error to a problem (400/401/403/404/409/500/503).
import { DomainError } from '../../shared/errors/domain-error';
import type { WagerResult } from '../../modules/wagering/application/wager-result';
import { WagerStatus } from '../../modules/wagering/domain/wager-status';
import { classifyError } from '../db/error-classification';
import { HttpProblem, invalidPayload } from './http-problem';

const VALIDATION_CODES = new Set([
  'INVALID_AMOUNT_FORMAT',
  'INVALID_AMOUNT_SCALE',
  'INVALID_AMOUNT_ZERO',
  'INVALID_CURRENCY',
  'INVALID_CURSOR',
]);

const PROGRAMMING_ERRORS = [TypeError, RangeError, ReferenceError, SyntaxError];

export interface HttpResponse {
  status: number;
  body: unknown;
}

export function mapWagerResultToHttp(result: WagerResult): HttpResponse {
  switch (result.type) {
    case 'IDEMPOTENCY_CONFLICT':
      throw new HttpProblem(
        409,
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was used with a different payload',
      );
    case 'EXTERNAL_ID_CONFLICT':
      throw new HttpProblem(
        409,
        'EXTERNAL_TRANSACTION_ID_CONFLICT',
        'The external transaction id was used with a different idempotency key',
      );
    case 'INBOX_DUPLICATE':
    case 'INBOX_PAYLOAD_CONFLICT':
      throw new Error(`Unexpected ${result.type} on the HTTP channel`);
    case 'RESULT': {
      const { view, replay } = result;
      const status =
        view.status === WagerStatus.Processed
          ? 200
          : view.status === WagerStatus.PendingReference
            ? 202
            : 422;

      return {
        status,
        body: {
          transactionId: view.transactionId,
          status: view.status,
          ...(view.failureCode !== undefined ? { failureCode: view.failureCode } : {}),
          balance: view.balance,
          idempotentReplay: replay,
        },
      };
    }
  }
}

function httpStatusOf(error: unknown): number | null {
  const status =
    (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;

  return typeof status === 'number' ? status : null;
}

export function toProblem(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) {
    return error;
  }
  if (error instanceof DomainError && VALIDATION_CODES.has(error.code)) {
    return new HttpProblem(400, error.code, error.message);
  }
  if ((error as { code?: unknown }).code === 'INVALID_LIMIT') {
    return invalidPayload('limit must be an integer between 1 and 200');
  }
  const type = (error as { type?: unknown } | null)?.type;

  if (
    type === 'entity.parse.failed' ||
    type === 'entity.too.large' ||
    type === 'encoding.unsupported'
  ) {
    return invalidPayload('The body must be valid JSON of at most 64 KB');
  }
  const status = httpStatusOf(error);

  if (status === 404) {
    return new HttpProblem(404, 'NOT_FOUND', 'Route not found');
  }
  if (status !== null && status >= 400 && status < 500) {
    return invalidPayload('Invalid request');
  }
  if (PROGRAMMING_ERRORS.some((kind) => error instanceof kind)) {
    return new HttpProblem(500, 'INTERNAL_ERROR', 'Unexpected error');
  }
  if (classifyError(error).kind === 'TRANSIENT') {
    return new HttpProblem(
      503,
      'SERVICE_UNAVAILABLE',
      'Temporary failure, retry later',
      {},
      {
        'Retry-After': '1',
      },
    );
  }

  return new HttpProblem(500, 'INTERNAL_ERROR', 'Unexpected error');
}
