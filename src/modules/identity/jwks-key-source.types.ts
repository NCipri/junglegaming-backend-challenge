// Settings of the JWT identity verifier.
export interface JwtIdentitySettings {
  issuer: string;
  audience: string;
  jwksUrl: string;
  timeoutMs: number;
}
