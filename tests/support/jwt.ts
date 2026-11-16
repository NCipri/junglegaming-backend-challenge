import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export const TEST_ISSUER = 'http://test-issuer.local/realms/wagering';
export const TEST_AUDIENCE = 'wagering-api';

export interface TestIssuer {
  jwksUrl: string;
  signToken(p: {
    clientId: string;
    roles: string[];
    audience?: string;
    issuer?: string;
    expiresIn?: string;
  }): Promise<string>;
  stop(): void;
}

export async function startTestIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ keys: [jwk] }),
  });

  return {
    jwksUrl: `http://127.0.0.1:${server.port}/certs`,
    signToken: (p) =>
      new SignJWT({ azp: p.clientId, realm_access: { roles: p.roles } })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(p.issuer ?? TEST_ISSUER)
        .setAudience(p.audience ?? TEST_AUDIENCE)
        .setSubject(`service-account-${p.clientId}`)
        .setIssuedAt()
        .setExpirationTime(p.expiresIn ?? '5m')
        .sign(privateKey),
    stop: () => {
      void server.stop(true);
    },
  };
}
