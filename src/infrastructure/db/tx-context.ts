// Transaction context: every repository bound to one EntityManager, so all writes share the same transaction.
import type { EntityManager } from '@mikro-orm/postgresql';
import { ProviderRegistry } from '../../modules/identity/provider-registry.repository';
import { InboxRepository } from '../../modules/messaging/infrastructure/inbox.repository';
import { OutboxRepository } from '../../modules/messaging/infrastructure/outbox.repository';
import type { MetricsPort } from '../../modules/observability/metrics.port';
import { WagerTransactionRepository } from '../../modules/wagering/infrastructure/wager-transaction.repository';
import { LedgerRepository } from '../../modules/wallet/infrastructure/ledger.repository';
import { WalletRepository } from '../../modules/wallet/infrastructure/wallet.repository';

export interface TxContext {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
  providers: ProviderRegistry;
}

export function createTxContext(em: EntityManager, metrics: MetricsPort): TxContext {
  return {
    wallets: new WalletRepository(em, metrics),
    ledger: new LedgerRepository(em),
    transactions: new WagerTransactionRepository(em),
    inbox: new InboxRepository(em),
    outbox: new OutboxRepository(em),
    providers: new ProviderRegistry(em),
  };
}
