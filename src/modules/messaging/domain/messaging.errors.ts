// Domain errors raised by inbox, outbox and integration-event construction.
import { DomainError } from '../../../shared/errors/domain-error';

export class InvalidMessageStateError extends DomainError {
  readonly code = 'INVALID_MESSAGE_STATE';

  constructor(detail: string) {
    super(`Invalid message state: ${detail}`);
  }
}
