// Provider endpoint to submit wager transactions and the shared transaction lookup by id.
import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CorrelationId } from '../../../infrastructure/http/correlation';
import { mapWagerResultToHttp } from '../../../infrastructure/http/error-mapping';
import { HttpProblem, notFound } from '../../../infrastructure/http/http-problem';
import { SubmitTransactionSchema, UUID } from '../../../infrastructure/http/schemas';
import { parseIdempotencyKey, parseWith } from '../../../infrastructure/http/validation';
import { Money } from '../../../shared/money/money';
import { CurrentViewer } from '../../identity/jwt-auth.guard';
import { Roles } from '../../identity/roles.decorator';
import { GetTransaction } from '../application/get-transaction';
import type { Viewer } from '../application/get-transaction.types';
import { ProcessWagerTransaction } from '../application/process-wager-transaction';
import type { WagerKind } from '../domain/wager-kind';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(GetTransaction) private readonly getTransaction: GetTransaction,
  ) {}

  @Post()
  @Roles('provider')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @CurrentViewer() viewer: Viewer,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const dto = parseWith(SubmitTransactionSchema, body);

    Money.from(dto.money);
    if (viewer.role !== 'provider' || viewer.providerId !== dto.providerId) {
      throw new HttpProblem(
        403,
        'PROVIDER_IDENTITY_MISMATCH',
        'providerId does not match the authenticated provider',
      );
    }
    const { referenceExternalTransactionId, ...fields } = dto;
    const result = await this.processWager.execute(
      {
        ...fields,
        kind: fields.kind as WagerKind,
        ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
        idempotencyKey,
        correlationId,
      },
      { type: 'HTTP' },
    );
    const response = mapWagerResultToHttp(result);

    res.status(response.status);

    return response.body;
  }

  @Get(':transactionId')
  @Roles('provider', 'operator')
  async byId(@Param('transactionId') transactionId: string, @CurrentViewer() viewer: Viewer) {
    const found = await this.getTransaction.byId(parseWith(UUID, transactionId), viewer);

    if (!found) {
      throw notFound('Transaction not found');
    }

    return found;
  }
}
