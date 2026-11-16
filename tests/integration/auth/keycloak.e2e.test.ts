import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { uuid } from '../../support/builders';
import { startKeycloak, type TestKeycloak } from '../../support/containers';
import { startTestApi, type TestApi } from '../../support/http';

let keycloak: TestKeycloak;
let api: TestApi;
let keycloakStopped = false;

beforeAll(async () => {
  keycloak = await startKeycloak();
  api = await startTestApi(
    {},
    { env: { AUTH_ISSUER: keycloak.issuer, AUTH_JWKS_URL: keycloak.jwksUrl } },
  );
}, 300_000);

afterAll(async () => {
  await api.stop();
  if (!keycloakStopped) {
    await keycloak.stop();
  }
});

describe('Keycloak as the identity provider', () => {
  test('client_credentials tokens carry the API audience, the client as azp and the realm role', async () => {
    const claims = decodeJwt(await keycloak.token('provider-a', 'provider-a-secret'));

    expect([claims.aud].flat()).toContain('wagering-api');
    expect(claims['azp']).toBe('provider-a');
    expect((claims['realm_access'] as { roles: string[] }).roles).toContain('provider');
  });

  test('backoffice creates a wallet; provider-a submits for itself, not for provider-b; a tampered token is 401', async () => {
    const operator = await keycloak.token('backoffice', 'backoffice-secret');
    const providerA = await keycloak.token('provider-a', 'provider-a-secret');
    const playerId = uuid();
    const created = await api.request('POST', '/wallets', {
      token: operator,
      body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    });

    expect(created.status).toBe(201);
    const body = (providerId: string, externalTransactionId: string) => ({
      providerId,
      externalTransactionId,
      playerId,
      walletId: String(created.json['id']),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    const own = await api.request('POST', '/wagering/transactions', {
      token: providerA,
      body: body('provider-a', 'kc-1'),
      headers: { 'idempotency-key': 'provider-a:kc-1' },
    });
    const foreign = await api.request('POST', '/wagering/transactions', {
      token: providerA,
      body: body('provider-b', 'kc-2'),
      headers: { 'idempotency-key': 'provider-b:kc-2' },
    });
    const tampered = `${providerA.slice(0, -4)}${providerA.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;

    expect(own.status).toBe(200);
    expect(foreign.status).toBe(403);
    expect(foreign.json['code']).toBe('PROVIDER_IDENTITY_MISMATCH');
    expect(
      (await api.request('GET', `/wallets/${String(created.json['id'])}`, { token: tampered }))
        .status,
    ).toBe(401);
    expect(
      (
        await api.request('POST', '/wallets', {
          token: providerA,
          body: { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } },
        })
      ).status,
    ).toBe(403);
  });

  test('with Keycloak down, cached keys keep validating, readiness stays up, and an unknown key inside the refetch cooldown is rejected without hitting Keycloak', async () => {
    const operator = await keycloak.token('backoffice', 'backoffice-secret');
    const header = decodeProtectedHeader(operator);

    expect((await api.request('GET', `/wallets/${uuid()}`, { token: operator })).status).toBe(404);
    await keycloak.stop();
    keycloakStopped = true;
    const before = api.metrics.counter('jwks_fetch_failures_total');

    expect((await api.request('GET', `/wallets/${uuid()}`, { token: operator })).status).toBe(404);
    expect((await api.request('GET', '/health/ready', { token: null })).status).toBe(200);
    expect(api.metrics.counter('jwks_fetch_failures_total')).toBe(before);
    const [, payload, signature] = operator.split('.');
    const unknownKid = `${Buffer.from(JSON.stringify({ ...header, kid: 'rotated-key' })).toString('base64url')}.${payload}.${signature}`;
    const refetch = await api.request('GET', `/wallets/${uuid()}`, { token: unknownKid });

    expect(refetch.status).toBe(401);
    expect(api.metrics.counter('jwks_fetch_failures_total')).toBe(before);
  }, 60_000);
});
