// OpenAPI 3.1 document generated from the same Zod schemas that validate the requests.
import { Controller, Get, Header } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../../modules/identity/roles.decorator';
import { CreateWalletSchema, SubmitTransactionSchema } from './schemas';

const problem = { $ref: '#/components/schemas/Problem' };
const responses = (codes: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(codes).map(([status, description]) => [
      status,
      status.startsWith('2')
        ? { description }
        : { description, content: { 'application/problem+json': { schema: problem } } },
    ]),
  );
const bearer = [{ bearer: [] }];

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Wagering Processor API', version: '1.0.0' },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      CreateWallet: z.toJSONSchema(CreateWalletSchema),
      SubmitTransaction: z.toJSONSchema(SubmitTransactionSchema),
      Problem: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          code: { type: 'string' },
          detail: { type: 'string' },
          correlationId: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/wallets': {
      post: {
        security: bearer,
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateWallet' } },
          },
        },
        responses: responses({
          201: 'Wallet created',
          400: 'Invalid payload',
          401: 'Unauthenticated',
          403: 'Forbidden',
          409: 'WALLET_ALREADY_EXISTS',
          503: 'Transient failure',
        }),
      },
    },
    '/wallets/{walletId}': {
      get: { security: bearer, responses: responses({ 200: 'Wallet', 404: 'Not found' }) },
    },
    '/wallets/{walletId}/ledger': {
      get: {
        security: bearer,
        responses: responses({
          200: 'Ledger page (newest first)',
          400: 'INVALID_CURSOR',
          404: 'Not found',
        }),
      },
    },
    '/wallets/{walletId}/reconciliation': {
      post: {
        security: bearer,
        responses: responses({ 200: 'Reconciliation report', 404: 'Not found' }),
      },
    },
    '/wagering/transactions': {
      post: {
        security: bearer,
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', maxLength: 255 },
          },
        ],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SubmitTransaction' } },
          },
        },
        responses: responses({
          200: 'Processed or replay',
          202: 'Pending reference',
          400: 'Invalid payload',
          401: 'Unauthenticated',
          403: 'PROVIDER_IDENTITY_MISMATCH',
          409: 'IDEMPOTENCY_CONFLICT or EXTERNAL_TRANSACTION_ID_CONFLICT',
          422: 'REJECTED or FAILED',
          503: 'Transient failure, retry',
        }),
      },
    },
    '/wagering/transactions/{transactionId}': {
      get: { security: bearer, responses: responses({ 200: 'Transaction', 404: 'Not found' }) },
    },
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
      get: {
        security: bearer,
        responses: responses({
          200: 'Transaction',
          403: 'PROVIDER_IDENTITY_MISMATCH',
          404: 'Not found',
        }),
      },
    },
    '/health/live': { get: { responses: responses({ 200: 'Process alive' }) } },
    '/health/ready': { get: { responses: responses({ 200: 'Ready', 503: 'Not ready' }) } },
  },
} as const;

@Controller()
@Public()
export class OpenApiController {
  @Get('docs-json')
  document() {
    return OPENAPI_DOCUMENT;
  }

  @Get('docs')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  docs() {
    return 'OpenAPI 3.1 document available at /docs-json';
  }
}
