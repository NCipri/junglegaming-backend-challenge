// Global exception filter: every error leaves as RFC 9457 problem details with the correlation id.
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppLogger } from '../../modules/observability/logger.port';
import { correlationIdOf } from './correlation';
import { problemBody } from './http-problem';
import { toProblem } from './error-mapping';

export function writeProblem(req: Request, res: Response, error: unknown, logger: AppLogger): void {
  const problem = toProblem(error);
  const correlationId = correlationIdOf(req);

  if (problem.status >= 500) {
    logger.error(
      {
        correlationId,
        code: problem.code,
        error: error instanceof Error ? error.message : String(error),
      },
      'Request failed',
    );
  }
  for (const [name, value] of Object.entries(problem.headers)) {
    res.setHeader(name, value);
  }
  if (problem.status === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer');
  }
  res
    .status(problem.status)
    .type('application/problem+json')
    .send(problemBody(problem, correlationId));
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();

    writeProblem(http.getRequest<Request>(), http.getResponse<Response>(), exception, this.logger);
  }
}
