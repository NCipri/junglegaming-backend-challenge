// Lookup of a transaction by the provider's own external id; a provider may only read its own namespace.
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { HttpProblem, notFound } from '../../../infrastructure/http/http-problem';
import { PRINTABLE_ID } from '../../../infrastructure/http/schemas';
import { parseWith } from '../../../infrastructure/http/validation';
import { CurrentViewer } from '../../identity/jwt-auth.guard';
import { Roles } from '../../identity/roles.decorator';
import { GetTransaction } from '../application/get-transaction';
import type { Viewer } from '../application/get-transaction.types';

@Controller('providers/:providerId/wagering/transactions')
@Roles('provider', 'operator')
export class ProvidersController {
  constructor(@Inject(GetTransaction) private readonly getTransaction: GetTransaction) {}

  @Get(':externalTransactionId')
  async byExternalId(
    @Param('providerId') providerIdParam: string,
    @Param('externalTransactionId') externalIdParam: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    const providerId = parseWith(PRINTABLE_ID, providerIdParam);
    const externalId = parseWith(PRINTABLE_ID, externalIdParam);

    if (viewer.role === 'provider' && viewer.providerId !== providerId) {
      throw new HttpProblem(
        403,
        'PROVIDER_IDENTITY_MISMATCH',
        'Providers can only read their own transactions',
      );
    }
    const found = await this.getTransaction.byExternalId(providerId, externalId, viewer);

    if (!found) {
      throw notFound('Transaction not found');
    }

    return found;
  }
}
