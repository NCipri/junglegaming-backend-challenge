// Parses a WagerTransactionRequested message with the same rules as HTTP; anything malformed is a permanent error.
import { z } from 'zod';
import { HttpProblem } from '../../../infrastructure/http/http-problem';
import { PRINTABLE_ID, SubmitTransactionSchema } from '../../../infrastructure/http/schemas';
import { parseIdempotencyKey } from '../../../infrastructure/http/validation';
import { canonicalJson, sha256Hex } from '../../../shared/hashing/canonical-json';
import { DomainError } from '../../../shared/errors/domain-error';
import { Money } from '../../../shared/money/money';
import type { WagerCommand } from '../application/wager-command';
import type { WagerKind } from '../domain/wager-kind';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export class PermanentMessageError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'PermanentMessageError';
  }
}

const MessageSchema = z.strictObject({
  messageId: PRINTABLE_ID,
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.iso.datetime(),
  data: z.strictObject({ ...SubmitTransactionSchema.shape, idempotencyKey: z.string() }),
});

export interface ParsedWagerMessage {
  messageId: string;
  messageHash: string;
  command: WagerCommand;
}

function readJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new PermanentMessageError('INVALID_JSON', 'The message body is not valid JSON');
  }
}

export class WagerMessageHandler {
  parse(body: string, correlationId?: string): ParsedWagerMessage {
    const parsed = MessageSchema.safeParse(readJson(body));

    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(body)');

      throw new PermanentMessageError(
        'INVALID_MESSAGE',
        `Invalid fields: ${[...new Set(fields)].join(', ')}`,
      );
    }
    const { messageId, type, data } = parsed.data;
    const { referenceExternalTransactionId, idempotencyKey, ...fields } = data;

    try {
      Money.from(fields.money);
      parseIdempotencyKey(idempotencyKey);
    } catch (error) {
      if (error instanceof DomainError || error instanceof HttpProblem) {
        throw new PermanentMessageError(error.code, error.message);
      }
      throw error;
    }

    return {
      messageId,
      messageHash: sha256Hex(canonicalJson({ type, data })),
      command: {
        ...fields,
        kind: fields.kind as WagerKind,
        ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
        idempotencyKey,
        correlationId: correlationId ?? messageId,
      },
    };
  }
}
