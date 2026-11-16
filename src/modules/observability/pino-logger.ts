// pino JSON logger behind the AppLogger port, with redaction of money, balances, player ids, tokens and bodies.
import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppLogger, LogContext } from './logger.port';

const SENSITIVE = [
  'amount',
  'balance',
  'money',
  'playerId',
  'storedBalance',
  'calculatedBalance',
  'difference',
  'observedBalance',
  'initialBalance',
  'authorization',
  'token',
  'body',
];

export const REDACT_PATHS = [
  ...SENSITIVE,
  ...SENSITIVE.map((field) => `*.${field}`),
  ...SENSITIVE.map((field) => `*.*.${field}`),
  'req.headers.authorization',
  'req.body',
];

export interface PinoLoggerOptions {
  level: string;
  instanceId: string;
  destination?: DestinationStream;
}

export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger) {}

  info(context: LogContext, message: string): void {
    this.logger.info(context, message);
  }

  warn(context: LogContext, message: string): void {
    this.logger.warn(context, message);
  }

  error(context: LogContext, message: string): void {
    this.logger.error(context, message);
  }
}

export function createPinoLogger(options: PinoLoggerOptions): PinoAppLogger {
  const logger = pino(
    {
      level: options.level,
      base: { instanceId: options.instanceId },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    options.destination ?? pino.destination({ sync: false }),
  );

  return new PinoAppLogger(logger);
}
