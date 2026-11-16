import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Request } from 'express';
import type { HttpProblem } from '../../../src/infrastructure/http/http-problem';
import { JwtProviderIdentity } from '../../../src/modules/identity/jwks-key-source';
import { startTestIssuer, TEST_AUDIENCE, TEST_ISSUER, type TestIssuer } from '../../support/jwt';
import { InMemoryMetrics } from '../../support/metrics';

let issuer: TestIssuer;

beforeAll(async () => {
  issuer = await startTestIssuer();
});

afterAll(() => {
  issuer.stop();
});

function request(token: string): Request {
  return {
    header: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined),
  } as Request;
}

async function problemOf(work: Promise<unknown>): Promise<HttpProblem> {
  try {
    await work;
  } catch (error) {
    return error as HttpProblem;
  }
  throw new Error('expected a problem');
}

function identity(jwksUrl: string, metrics = new InMemoryMetrics()) {
  return new JwtProviderIdentity(
    { issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwksUrl, timeoutMs: 500 },
    metrics,
  );
}

describe('JwtProviderIdentity', () => {
  test('a provider token resolves to its azp; an operator token to the operator role', async () => {
    const verifier = identity(issuer.jwksUrl);

    expect(
      await verifier.resolve(
        request(await issuer.signToken({ clientId: 'provider-a', roles: ['provider'] })),
      ),
    ).toEqual({
      role: 'provider',
      providerId: 'provider-a',
    });
    expect(
      await verifier.resolve(
        request(await issuer.signToken({ clientId: 'ops', roles: ['operator'] })),
      ),
    ).toEqual({
      role: 'operator',
    });
  });

  test('a valid token without an accepted role is FORBIDDEN', async () => {
    const token = await issuer.signToken({ clientId: 'someone', roles: ['viewer'] });
    const problem = await problemOf(identity(issuer.jwksUrl).resolve(request(token)));

    expect([problem.status, problem.code]).toEqual([403, 'FORBIDDEN']);
  });

  test('an expired token or a wrong issuer is UNAUTHENTICATED', async () => {
    const expired = await issuer.signToken({
      clientId: 'provider-a',
      roles: ['provider'],
      expiresIn: '-1m',
    });
    const foreign = await issuer.signToken({
      clientId: 'provider-a',
      roles: ['provider'],
      issuer: 'http://evil',
    });

    for (const token of [expired, foreign]) {
      const problem = await problemOf(identity(issuer.jwksUrl).resolve(request(token)));

      expect([problem.status, problem.code]).toEqual([401, 'UNAUTHENTICATED']);
    }
  });

  test('an unreachable JWKS is a 503 and is counted, not a 401', async () => {
    const metrics = new InMemoryMetrics();
    const token = await issuer.signToken({ clientId: 'provider-a', roles: ['provider'] });
    const problem = await problemOf(
      identity('http://127.0.0.1:1/certs', metrics).resolve(request(token)),
    );

    expect([problem.status, problem.code]).toEqual([503, 'SERVICE_UNAVAILABLE']);
    expect(metrics.counter('jwks_fetch_failures_total')).toBe(1);
  });
});
