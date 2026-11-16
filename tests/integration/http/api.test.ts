import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { resetDatabase } from '../../support/database';
import { uuid } from '../../support/builders';
import { assertAllWalletsInvariants } from '../../support/invariants';
import { startTestApi, type ApiResponse, type TestApi } from '../../support/http';

let api: TestApi;
let db: Client;
let providerA: string;
let providerB: string;

beforeAll(async () => {
  api = await startTestApi();
  db = new Client({ connectionString: api.pg.migratorUrl });
  await db.connect();
  providerA = await api.providerToken('provider-a');
  providerB = await api.providerToken('provider-b');
}, 180_000);

afterAll(async () => {
  await db.end();
  await api.stop();
});

beforeEach(async () => {
  await resetDatabase(api.pg.migratorUrl);
});

let seq = 0;

async function createWallet(amount = '1000.00') {
  const res = await api.request('POST', '/wallets', {
    body: { playerId: uuid(), initialBalance: { amount, currency: 'BRL' } },
  });

  expect(res.status).toBe(201);

  return res.json as { id: string; playerId: string };
}

function transaction(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
  seq += 1;

  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${Date.now()}-${seq}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function submit(body: Record<string, unknown>, opts: { key?: string | null; token?: string } = {}) {
  const key =
    opts.key === undefined
      ? `${String(body['providerId'])}:${String(body['externalTransactionId'])}`
      : opts.key;

  return api.request('POST', '/wagering/transactions', {
    token: opts.token ?? providerA,
    body,
    headers: key === null ? {} : { 'idempotency-key': key },
  });
}

function expectProblem(res: ApiResponse, status: number, code: string) {
  expect({ status: res.status, code: res.json['code'] }).toEqual({ status, code });
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  expect(res.json).toMatchObject({ status, code, correlationId: expect.any(String) as string });
}

function moneyFieldsAreStrings(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(moneyFieldsAreStrings);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(([key, member]) => {
      if (['amount', 'balance'].includes(key) && typeof member === 'number') {
        return false;
      }

      return moneyFieldsAreStrings(member);
    });
  }

  return true;
}

async function rows(table: string): Promise<number> {
  const { rows: result } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);

  return result[0]?.n ?? 0;
}

describe('status table — success', () => {
  test('201 wallet created with the README shape, plus instance and correlation headers', async () => {
    const playerId = uuid();
    const res = await api.request('POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      headers: { 'x-correlation-id': 'corr-123' },
    });

    expect(res.status).toBe(201);
    expect(res.json).toEqual({
      id: expect.any(String) as string,
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(res.headers.get('x-instance-id')).toBe('test-instance');
    expect(res.headers.get('x-correlation-id')).toBe('corr-123');
  });

  test('200 processed, then 200 idempotent replay with the same body', async () => {
    const wallet = await createWallet();
    const body = transaction(wallet);
    const first = await submit(body);
    const replay = await submit(body);

    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      transactionId: expect.any(String) as string,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ...first.json, idempotentReplay: true });
  });

  test('202 pending reference for a ROLLBACK that arrives before its BET', async () => {
    const wallet = await createWallet();
    const res = await submit(
      transaction(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'later' }),
    );

    expect(res.status).toBe(202);
    expect(res.json['status']).toBe('PENDING_REFERENCE');
  });

  test('200 reads: wallet, transaction by id and by external id, reconciliation', async () => {
    const wallet = await createWallet();
    const body = transaction(wallet);
    const submitted = await submit(body);
    const id = String(submitted.json['transactionId']);

    expect((await api.request('GET', `/wallets/${wallet.id}`)).json['balance']).toEqual({
      amount: '975.00',
      currency: 'BRL',
    });
    expect(
      (await api.request('GET', `/wagering/transactions/${id}`, { token: providerA })).json[
        'status'
      ],
    ).toBe('PROCESSED');
    expect(
      (
        await api.request(
          'GET',
          `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
          {
            token: providerA,
          },
        )
      ).json['transactionId'],
    ).toBe(id);
    const reconciliation = await api.request('POST', `/wallets/${wallet.id}/reconciliation`);

    expect(reconciliation.status).toBe(200);
    expect(reconciliation.json).toMatchObject({
      consistent: true,
      difference: { amount: '0.00', currency: 'BRL' },
    });
  });
});

describe('status table — 400 invalid payload, nothing recorded', () => {
  test.each([
    ['walletId is not a UUID', { walletId: 'abc' }, 'INVALID_PAYLOAD'],
    ['roundId has 121 characters', { roundId: 'r'.repeat(121) }, 'INVALID_PAYLOAD'],
    ['providerId is "internal"', { providerId: 'internal' }, 'INVALID_PAYLOAD'],
    ['externalTransactionId is empty', { externalTransactionId: '' }, 'INVALID_PAYLOAD'],
    ['gameId has a control character', { gameId: 'game\u0001' }, 'INVALID_PAYLOAD'],
    ['an unknown field is present', { extra: true }, 'INVALID_PAYLOAD'],
    [
      'amount is a JSON number',
      { money: { amount: 25, currency: 'BRL' } },
      'INVALID_AMOUNT_FORMAT',
    ],
    [
      'amount uses a comma',
      { money: { amount: '25,00', currency: 'BRL' } },
      'INVALID_AMOUNT_FORMAT',
    ],
    [
      'amount has one decimal',
      { money: { amount: '25.5', currency: 'BRL' } },
      'INVALID_AMOUNT_SCALE',
    ],
    ['a BET of zero', { money: { amount: '0.00', currency: 'BRL' } }, 'INVALID_AMOUNT_ZERO'],
    ['currency is lowercase', { money: { amount: '25.00', currency: 'brl' } }, 'INVALID_CURRENCY'],
  ])('%s', async (_, overrides, code) => {
    const wallet = await createWallet();
    const before = await rows('wager_transactions');
    const body = transaction(wallet, overrides);
    const res = await submit(body, { key: `key-${seq}` });

    expectProblem(res, 400, code);
    expect(await rows('wager_transactions')).toBe(before);
  });

  test.each([
    ['missing', null, 'IDEMPOTENCY_KEY_MISSING'],
    ['blank', '   ', 'IDEMPOTENCY_KEY_MISSING'],
    ['256 characters', 'k'.repeat(256), 'INVALID_PAYLOAD'],
    ['non-ASCII', 'chave-ç', 'INVALID_PAYLOAD'],
  ])('Idempotency-Key %s', async (_, key, code) => {
    const wallet = await createWallet();
    const res = await submit(transaction(wallet), { key });

    expectProblem(res, 400, code);
  });

  test('a non-JSON body and a malformed JSON body are INVALID_PAYLOAD', async () => {
    const asText = await api.request('POST', '/wallets', {
      rawBody: 'playerId=1',
      headers: { 'content-type': 'text/plain' },
    });
    const malformed = await api.request('POST', '/wallets', {
      rawBody: '{"playerId":',
      headers: { 'content-type': 'application/json' },
    });

    expectProblem(asText, 400, 'INVALID_PAYLOAD');
    expectProblem(malformed, 400, 'INVALID_PAYLOAD');
  });

  test('a body above 64 KB is INVALID_PAYLOAD', async () => {
    const res = await api.request('POST', '/wallets', {
      rawBody: JSON.stringify({ playerId: uuid(), pad: 'x'.repeat(70_000) }),
      headers: { 'content-type': 'application/json' },
    });

    expectProblem(res, 400, 'INVALID_PAYLOAD');
  });

  test('an invalid ledger cursor is INVALID_CURSOR and limit 201 is INVALID_PAYLOAD', async () => {
    const wallet = await createWallet();

    expectProblem(
      await api.request('GET', `/wallets/${wallet.id}/ledger?cursor=!!`),
      400,
      'INVALID_CURSOR',
    );
    expectProblem(
      await api.request('GET', `/wallets/${wallet.id}/ledger?limit=201`),
      400,
      'INVALID_PAYLOAD',
    );
  });
});

describe('status table — 401, 403 and 404', () => {
  test('401 without a token, with a garbage token and with a wrong audience', async () => {
    const wrongAudience = await api.issuer.signToken({
      clientId: 'provider-a',
      roles: ['provider'],
      audience: 'x',
    });

    expectProblem(
      await api.request('GET', '/wallets/' + uuid(), { token: null }),
      401,
      'UNAUTHENTICATED',
    );
    expectProblem(
      await api.request('GET', '/wallets/' + uuid(), { token: 'garbage' }),
      401,
      'UNAUTHENTICATED',
    );
    expectProblem(
      await submit({ providerId: 'provider-a' }, { token: wrongAudience }),
      401,
      'UNAUTHENTICATED',
    );
  });

  test('403 when a provider calls an operator endpoint', async () => {
    const res = await api.request('POST', '/wallets', {
      token: providerA,
      body: { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } },
    });

    expectProblem(res, 403, 'FORBIDDEN');
    expect(await rows('wallets')).toBe(0);
  });

  test('403 PROVIDER_IDENTITY_MISMATCH when the body names another provider; nothing recorded', async () => {
    const wallet = await createWallet();
    const res = await submit(transaction(wallet, { providerId: 'provider-b' }), {
      token: providerA,
    });

    expectProblem(res, 403, 'PROVIDER_IDENTITY_MISMATCH');
    expect(await rows('wager_transactions')).toBe(1);
  });

  test('403 when a provider reads another provider namespace; 404 for another provider transaction id', async () => {
    const wallet = await createWallet();
    const body = transaction(wallet);
    const id = String((await submit(body)).json['transactionId']);

    expectProblem(
      await api.request(
        'GET',
        `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
        {
          token: providerB,
        },
      ),
      403,
      'PROVIDER_IDENTITY_MISMATCH',
    );
    expectProblem(
      await api.request('GET', `/wagering/transactions/${id}`, { token: providerB }),
      404,
      'NOT_FOUND',
    );
    expectProblem(await api.request('GET', `/wallets/${uuid()}`), 404, 'NOT_FOUND');
    expectProblem(await api.request('GET', '/nope', { token: null }), 404, 'NOT_FOUND');
  });
});

describe('status table — 409 and 422', () => {
  test('409 WALLET_ALREADY_EXISTS carries the existing wallet id', async () => {
    const playerId = uuid();
    const body = { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } };
    const first = await api.request('POST', '/wallets', { body });
    const second = await api.request('POST', '/wallets', { body });

    expectProblem(second, 409, 'WALLET_ALREADY_EXISTS');
    expect(second.json['walletId']).toBe(first.json['id']);
  });

  test('409 IDEMPOTENCY_CONFLICT never reveals the original payload', async () => {
    const wallet = await createWallet();
    const body = transaction(wallet);

    await submit(body);
    const res = await submit({ ...body, money: { amount: '26.00', currency: 'BRL' } });

    expectProblem(res, 409, 'IDEMPOTENCY_CONFLICT');
    expect(res.text).not.toContain('25.00');
  });

  test('409 EXTERNAL_TRANSACTION_ID_CONFLICT for the same external id under another key', async () => {
    const wallet = await createWallet();
    const body = transaction(wallet);

    await submit(body);
    expectProblem(
      await submit(body, { key: 'another-key' }),
      409,
      'EXTERNAL_TRANSACTION_ID_CONFLICT',
    );
  });

  test('422 REJECTED with the failure code and the observed balance', async () => {
    const wallet = await createWallet('10.00');
    const res = await submit(transaction(wallet));

    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  test('422 FAILED for a NUMERIC(19,2) overflow, and 422 FAILED again on replay', async () => {
    const wallet = await createWallet('99999999999999999.00');
    const body = transaction(wallet, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } });
    const first = await submit(body);
    const replay = await submit(body);

    expect(first.status).toBe(422);
    expect(first.json).toMatchObject({
      status: 'FAILED',
      failureCode: 'UNEXPECTED_PROCESSING_ERROR',
    });
    expect(replay.status).toBe(422);
    expect(replay.json).toMatchObject({ status: 'FAILED', idempotentReplay: true });
    expect((await api.request('GET', `/wallets/${wallet.id}`)).json['balance']).toEqual({
      amount: '99999999999999999.00',
      currency: 'BRL',
    });
  });
});

describe('ledger pagination', () => {
  test('120 entries in pages of 50: three pages, newest first, no gaps or repeats', async () => {
    const wallet = await createWallet('1000.00');

    for (let i = 0; i < 119; i++) {
      expect(
        (await submit(transaction(wallet, { money: { amount: '1.00', currency: 'BRL' } }))).status,
      ).toBe(200);
    }
    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query: string = cursor ? `?limit=50&cursor=${cursor}` : '?limit=50';
      const page = await api.request('GET', `/wallets/${wallet.id}/ledger${query}`);
      const items = page.json['items'] as { walletVersion: number }[];

      versions.push(...items.map((item) => item.walletVersion));
      cursor = page.json['nextCursor'] as string | null;
      pages += 1;
      expect(moneyFieldsAreStrings(page.json)).toBe(true);
    } while (cursor);

    expect(pages).toBe(3);
    expect(versions).toEqual(Array.from({ length: 120 }, (_, i) => 120 - i));
    await assertAllWalletsInvariants(db);
  }, 60_000);
});

describe('documents and health', () => {
  test('responses never carry numbers, NaN or Infinity in money fields', async () => {
    const wallet = await createWallet();
    const res = await submit(transaction(wallet));

    expect(moneyFieldsAreStrings(res.json)).toBe(true);
    expect(res.text).not.toMatch(/NaN|Infinity/);
  });

  test('GET /docs-json serves the OpenAPI document without authentication', async () => {
    const res = await api.request('GET', '/docs-json', { token: null });

    expect(res.status).toBe(200);
    expect(res.json['openapi']).toBe('3.1.0');
    expect(Object.keys(res.json['paths'] as object)).toContain('/wagering/transactions');
  });

  test('health endpoints need no authentication; ready checks PostgreSQL and SQS', async () => {
    const live = await api.request('GET', '/health/live', { token: null });
    const ready = await api.request('GET', '/health/ready', { token: null });

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(ready.json).toEqual({
      status: 'up',
      checks: { database: 'up', sqs: 'up', shuttingDown: false },
    });
  });
});
