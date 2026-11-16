const clientId = process.argv.slice(2).find((arg) => arg !== '--');
const secrets: Record<string, string> = {
  'provider-a': 'provider-a-secret',
  'provider-b': 'provider-b-secret',
  backoffice: 'backoffice-secret',
};

if (!clientId || !(clientId in secrets)) {
  console.error(`Usage: bun run auth:token <${Object.keys(secrets).join('|')}>`);
  process.exit(1);
}
const issuer = process.env.AUTH_ISSUER ?? 'http://localhost:8081/realms/wagering';
const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: process.env.AUTH_CLIENT_SECRET ?? secrets[clientId] ?? '',
  }),
});

if (!response.ok) {
  console.error(`Token request failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}
const { access_token: token } = (await response.json()) as { access_token: string };

console.log(token);

export {};
