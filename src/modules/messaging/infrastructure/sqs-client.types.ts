// Options of the SQS client factory.
export interface SqsClientOptions {
  endpoint: string;
  region: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}
