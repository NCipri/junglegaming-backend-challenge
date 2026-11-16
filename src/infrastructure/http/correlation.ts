// Correlation id and instance id on every request and response; the id is reused when the caller sends a valid one.
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { IdGenerator } from '../../shared/ids/id-generator';

const VALID_CORRELATION_ID = /^[!-~]{1,128}$/;
const CORRELATION = Symbol('correlationId');

type CorrelatedRequest = Request & { [CORRELATION]?: string };

export function correlationIdOf(req: Request): string {
  return (req as CorrelatedRequest)[CORRELATION] ?? 'unknown';
}

export function correlationMiddleware(ids: IdGenerator, instanceId: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && VALID_CORRELATION_ID.test(incoming) ? incoming : ids.next();

    (req as CorrelatedRequest)[CORRELATION] = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    res.setHeader('X-Instance-Id', instanceId);
    next();
  };
}

export const CorrelationId = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  correlationIdOf(ctx.switchToHttp().getRequest<Request>()),
);
