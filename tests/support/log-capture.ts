import { Writable } from 'node:stream';
import { createPinoLogger, type PinoAppLogger } from '../../src/modules/observability/pino-logger';

export interface LogCapture {
  logger: PinoAppLogger;
  lines(): string[];
  entries(): Record<string, unknown>[];
}

export function captureLogs(): LogCapture {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createPinoLogger({
    level: 'debug',
    instanceId: 'test-instance',
    destination: sink,
  });
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);

  return {
    logger,
    lines,
    entries: () => lines().map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
