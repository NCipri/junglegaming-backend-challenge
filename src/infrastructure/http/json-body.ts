// JSON-only body parsing limited to 64 KB; failures are answered as problem details before reaching Nest.
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppLogger } from '../../modules/observability/logger.port';
import { invalidPayload } from './http-problem';
import { writeProblem } from './problem-details.filter';

export const MAX_BODY = '64kb';

export function jsonBodyMiddleware(logger: AppLogger) {
  const parse = express.json({ limit: MAX_BODY, type: 'application/json', strict: true });

  return (req: Request, res: Response, next: NextFunction): void => {
    const hasBody =
      (req.headers['content-length'] ?? '0') !== '0' ||
      req.headers['transfer-encoding'] !== undefined;

    if (hasBody && !req.is('application/json')) {
      writeProblem(req, res, invalidPayload('Only application/json bodies are accepted'), logger);

      return;
    }
    parse(req, res, (error?: unknown) => {
      if (error) {
        writeProblem(req, res, error, logger);

        return;
      }
      next();
    });
  };
}
