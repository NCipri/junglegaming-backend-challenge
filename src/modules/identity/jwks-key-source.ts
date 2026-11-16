// OIDC JWT verification against a cached remote JWKS: signature, issuer, audience and expiry.
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { HttpProblem } from '../../infrastructure/http/http-problem';
import type { MetricsPort } from '../observability/metrics.port';
import type { Viewer } from '../wagering/application/get-transaction.types';
import type { ProviderIdentityPort } from './provider-identity.port';
import type { JwtIdentitySettings } from './jwks-key-source.types';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

const unauthenticated = (detail: string) => new HttpProblem(401, 'UNAUTHENTICATED', detail);

function rolesOf(payload: JWTPayload): string[] {
  const realmAccess = payload['realm_access'];
  const roles = (realmAccess as { roles?: unknown } | undefined)?.roles;

  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === 'string')
    : [];
}

export class JwtProviderIdentity implements ProviderIdentityPort {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly settings: JwtIdentitySettings,
    private readonly metrics: MetricsPort,
  ) {
    this.jwks = createRemoteJWKSet(new URL(settings.jwksUrl), {
      timeoutDuration: settings.timeoutMs,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  }

  async resolve(req: Request): Promise<Viewer> {
    const match = BEARER.exec(req.header('authorization') ?? '');

    if (!match?.[1]) {
      throw unauthenticated('A bearer token is required');
    }
    const payload = await this.verify(match[1]);
    const roles = rolesOf(payload);

    if (roles.includes('operator')) {
      return { role: 'operator' };
    }
    const azp = payload['azp'];

    if (roles.includes('provider') && typeof azp === 'string' && azp.length > 0) {
      return { role: 'provider', providerId: azp };
    }
    throw new HttpProblem(403, 'FORBIDDEN', 'The token carries no accepted role');
  }

  private async verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        algorithms: ['RS256'],
      });

      return payload;
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        this.metrics.increment('jwks_fetch_failures_total');
        throw new HttpProblem(
          503,
          'SERVICE_UNAVAILABLE',
          'Identity keys are unavailable',
          {},
          {
            'Retry-After': '1',
          },
        );
      }
      throw unauthenticated('The bearer token is invalid or expired');
    }
  }
}
