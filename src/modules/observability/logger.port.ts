// Structured logger port: context object first, message second; never log money, tokens or player ids.
export type LogContext = Record<string, unknown>;

export interface AppLogger {
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
}

export class NoopLogger implements AppLogger {
  info(): void {}

  warn(): void {}

  error(): void {}
}
