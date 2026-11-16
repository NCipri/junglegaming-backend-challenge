// Inbox message: persistent dedupe record of a consumed message, keyed by (consumerName, messageId).
import { InvalidMessageStateError } from './messaging.errors';
import type { InboxMessageState, ReceiveInboxProps } from './inbox-message.types';

export class InboxMessage {
  private constructor(private state: InboxMessageState) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage({
      messageId: props.messageId,
      consumerName: props.consumerName,
      payloadHash: props.payloadHash,
      receivedAt: new Date(props.at),
      processedAt: null,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  get messageId(): string {
    return this.state.messageId;
  }

  get consumerName(): string {
    return this.state.consumerName;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get receivedAt(): Date {
    return new Date(this.state.receivedAt);
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt ? new Date(this.state.processedAt) : undefined;
  }

  isProcessed(): boolean {
    return this.state.processedAt !== null;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(
        `inbox message ${this.state.messageId} is already processed`,
      );
    }
    this.state = { ...this.state, processedAt: new Date(at) };
  }

  toState(): InboxMessageState {
    return { ...this.state };
  }
}
