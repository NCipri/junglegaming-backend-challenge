// Operator endpoints for wallets: create, read, ledger pages and reconciliation.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CorrelationId } from '../../../infrastructure/http/correlation';
import { HttpProblem, notFound } from '../../../infrastructure/http/http-problem';
import { CreateWalletSchema, LedgerQuerySchema, UUID } from '../../../infrastructure/http/schemas';
import { parseWith } from '../../../infrastructure/http/validation';
import { Money } from '../../../shared/money/money';
import { Roles } from '../../identity/roles.decorator';
import { GetWallet } from '../application/get-wallet';
import { ListLedger } from '../application/list-ledger';
import { OpenWallet } from '../application/open-wallet';
import { ReconcileWallet } from '../application/reconcile-wallet';

@Controller('wallets')
@Roles('operator')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(ListLedger) private readonly listLedger: ListLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @CorrelationId() correlationId: string) {
    const dto = parseWith(CreateWalletSchema, body);

    Money.from(dto.initialBalance);
    const result = await this.openWallet.execute({ ...dto, correlationId });

    if (result.type === 'ALREADY_EXISTS') {
      throw new HttpProblem(
        409,
        'WALLET_ALREADY_EXISTS',
        'The player already has a wallet in this currency',
        {
          walletId: result.walletId,
        },
      );
    }

    return result.wallet;
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.getWallet.execute(parseWith(UUID, walletId));

    if (!wallet) {
      throw notFound('Wallet not found');
    }

    return wallet;
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const id = parseWith(UUID, walletId);
    const { cursor, limit } = parseWith(LedgerQuerySchema, query);

    if (!(await this.getWallet.execute(id))) {
      throw notFound('Wallet not found');
    }

    return this.listLedger.execute(id, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const report = await this.reconcileWallet.execute(parseWith(UUID, walletId));

    if (!report) {
      throw notFound('Wallet not found');
    }

    return report;
  }
}
