// Persisted state and receive input of an inbox message.
export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  at: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}
