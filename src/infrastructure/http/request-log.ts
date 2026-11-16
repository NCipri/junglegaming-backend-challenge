// One structured log line per HTTP request: method, route path, status, duration and correlation id — never the body.
import type { NextFunction, Request, Response } from 'express';
import type { AppLogger } from '../../modules/observability/logger.port';
import { correlationIdOf } from './correlation';

export function requestLogMiddleware(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = performance.now();

    res.on('finish', () => {
      logger.info(
        {
          correlationId: correlationIdOf(req),
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'HTTP request',
      );
    });
    next();
  };
}
