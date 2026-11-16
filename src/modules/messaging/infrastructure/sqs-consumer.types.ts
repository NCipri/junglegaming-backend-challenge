// Port and settings of the SQS message consumer.
export interface MessageConsumerPort {
  start(): void;
  stop(opts: { graceMs: number }): Promise<void>;
}

export interface SqsConsumerSettings {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  heartbeatSeconds: number;
  retryBaseSeconds: number;
  retryCapSeconds: number;
  maxMessages: number;
}
