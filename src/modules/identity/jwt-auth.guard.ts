// Global guard: every route needs a valid token and an allowed role unless it is marked public.
import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { HttpProblem } from '../../infrastructure/http/http-problem';
import type { Viewer } from '../wagering/application/get-transaction.types';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from './provider-identity.port';
import { PUBLIC_KEY, ROLES_KEY, type Role } from './roles.decorator';

const VIEWER = Symbol('viewer');

type AuthenticatedRequest = Request & { [VIEWER]?: Viewer };

export function viewerOf(req: Request): Viewer {
  const viewer = (req as AuthenticatedRequest)[VIEWER];

  if (!viewer) {
    throw new HttpProblem(401, 'UNAUTHENTICATED', 'A bearer token is required');
  }

  return viewer;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const viewer = await this.identity.resolve(req);
    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets) ?? [];

    if (!allowed.includes(viewer.role)) {
      throw new HttpProblem(403, 'FORBIDDEN', 'This role cannot access this resource');
    }
    req[VIEWER] = viewer;

    return true;
  }
}

export const CurrentViewer = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  viewerOf(ctx.switchToHttp().getRequest<Request>()),
);
