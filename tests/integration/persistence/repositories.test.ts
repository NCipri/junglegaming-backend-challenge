import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { Client } from 'pg';
import { startPostgres, type TestPostgres } from '../../support/containers';
import { migrateUp, resetDatabase } from '../../support/database';
import { hashOf, money, newWager, NOW, seedWallet, uuid } from '../../support/builders';
import { assertWalletInvariants } from '../../support/invariants';
import { createTestOrm, type TestOrm } from '../../support/persistence';
import { VersionConflictError } from '../../../src/infrastructure/db/persistence.errors';
import type { TxContext } from '../../../src/infrastructure/db/tx-context';
import { InboxMessage } from '../../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import { WagerKind } from '../../../src/modules/wagering/domain/wager-kind';
import { WagerStatus } from '../../../src/modules/wagering/domain/wager-status';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { WalletLedgerEntry } from '../../../src/modules/wallet/domain/wallet-ledger-entry';

let pg: TestPostgres;
let db: Client;
let t: TestOrm;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateUp(pg.migratorUrl);
  db = new Client({ connectionString: pg.migratorUrl });
  await db.connect();
  t = await createTestOrm(pg.appUrl);
}, 120_000);

afterAll(async () => {
  await t.close();
  await db.end();
  await pg.stop();
});

beforeEach(async () => {
  await resetDatabase(pg.migratorUrl);
});

const later = (ms: number) => new Date(NOW.getTime() + ms);

async function applyBet(
  tx: TxContext,
  walletId: string,
  overrides: Partial<{ amount: string }> = {},
) {
  const wallet = await tx.wallets.lockById(walletId);

  if (!wallet) {
    throw new Error('wallet not found');
  }
  const expectedVersion = wallet.version;
  const bet = newWager(wallet, { money: money(overrides.amount ?? '10.00') });
  const entry = wallet.debit({
    money: bet.money,
    transactionId: bet.id,
    entryId: uuid(),
    at: NOW,
  });

  bet.markProcessed({ observedBalance: wallet.balance, at: NOW });
  await tx.wallets.saveBalance(wallet, expectedVersion);
  await tx.transactions.insert(bet);
  await tx.ledger.insert(entry);

  return { wallet, bet, entry };
}

function outboxMessage(walletId: string, occurredAt: Date): OutboxMessage {
  const id = uuid();

  return OutboxMessage.rehydrate({
    id,
    aggregateId: walletId,
    partitionKey: walletId,
    eventType: 'WalletBalanceChanged',
    eventVersion: 1,
    payload: { eventId: id, data: { amount: '10.00', currency: 'BRL', note: 'ação' } },
    occurredAt,
    attempts: 0,
    nextAttemptAt: occurredAt,
    publishedAt: null,
  });
}

describe('mappers always rebuild domain objects through rehydrate', () => {
  const spies: { mockRestore(): void }[] = [];

  afterEach(() => {
    spies.splice(0).forEach((spy) => {
      spy.mockRestore();
    });
  });

  test('wallets, ledger entries and transactions are read via rehydrate', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const walletSpy = spyOn(Wallet, 'rehydrate');
    const entrySpy = spyOn(WalletLedgerEntry, 'rehydrate');
    const txSpy = spyOn(WagerTransaction, 'rehydrate');

    spies.push(walletSpy, entrySpy, txSpy);
    const ctx = t.context();
    const wallet = await ctx.wallets.findById(seeded.wallet.id);
    const entries = await ctx.ledger.page(seeded.wallet.id, { limit: 5 });
    const opening = await ctx.transactions.findById(seeded.opening?.id ?? '');

    expect(wallet).toBeInstanceOf(Wallet);
    expect(entries[0]).toBeInstanceOf(WalletLedgerEntry);
    expect(opening).toBeInstanceOf(WagerTransaction);
    expect(walletSpy).toHaveBeenCalledTimes(1);
    expect(entrySpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledTimes(1);
  });

  test('a read wallet equals the written one, field by field', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '12.34' }));
    const read = await t.context().wallets.findById(seeded.wallet.id);

    expect(read?.toState()).toEqual(seeded.wallet.toState());
  });

  test('a read transaction equals the written one, field by field', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '50.00' }));
    const { bet } = await t.runner().run((tx) => applyBet(tx, seeded.wallet.id));
    const read = await t.context().transactions.findById(bet.id);

    expect(read?.toState()).toEqual(bet.toState());
  });
});

describe('WalletRepository', () => {
  test('findByPlayerAndCurrency finds the wallet; unknown ids return null', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '0.00' }));
    const ctx = t.context();

    expect((await ctx.wallets.findByPlayerAndCurrency(seeded.wallet.playerId, 'BRL'))?.id).toBe(
      seeded.wallet.id,
    );
    expect(await ctx.wallets.findByPlayerAndCurrency(seeded.wallet.playerId, 'USD')).toBeNull();
    expect(await ctx.wallets.findById(uuid())).toBeNull();
    expect(await t.runner().run((tx) => tx.wallets.lockById(uuid()))).toBeNull();
  });

  test('saveBalance with a stale expected version throws VersionConflictError and writes nothing', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const ctx = t.context();
    const wallet = await ctx.wallets.findById(seeded.wallet.id);

    if (!wallet) {
      throw new Error('wallet not found');
    }
    wallet.credit({ money: money('5.00'), transactionId: uuid(), entryId: uuid(), at: NOW });

    expect(ctx.wallets.saveBalance(wallet, wallet.version)).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    expect((await ctx.wallets.findById(seeded.wallet.id))?.balance.toJSON().amount).toBe('100.00');
  });

  test('saveBalance with the expected version persists balance and version', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));

    await t.runner().run((tx) => applyBet(tx, seeded.wallet.id, { amount: '30.00' }));
    const wallet = await t.context().wallets.findById(seeded.wallet.id);

    expect(wallet?.balance.toJSON().amount).toBe('70.00');
    expect(wallet?.version).toBe(2);
    await assertWalletInvariants(db, seeded.wallet.id);
  });
});

describe('LedgerRepository', () => {
  test('page returns newest first and honours beforeVersion and limit', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));

    for (let i = 0; i < 4; i++) {
      await t.runner().run((tx) => applyBet(tx, seeded.wallet.id, { amount: '1.00' }));
    }
    const ctx = t.context();
    const first = await ctx.ledger.page(seeded.wallet.id, { limit: 2 });
    const second = await ctx.ledger.page(seeded.wallet.id, { limit: 2, beforeVersion: 4 });
    const last = await ctx.ledger.page(seeded.wallet.id, { limit: 10, beforeVersion: 2 });

    expect(first.map((e) => e.walletVersion)).toEqual([5, 4]);
    expect(second.map((e) => e.walletVersion)).toEqual([3, 2]);
    expect(last.map((e) => e.walletVersion)).toEqual([1]);
    await assertWalletInvariants(db, seeded.wallet.id);
  });

  test('reconciliationSnapshot of a consistent wallet', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));

    await t.runner().run((tx) => applyBet(tx, seeded.wallet.id, { amount: '25.50' }));

    expect(await t.context().ledger.reconciliationSnapshot(seeded.wallet.id)).toEqual({
      stored: '74.50',
      walletVersion: 2,
      calculated: '74.50',
      entries: 2,
      chainIntact: true,
      firstBrokenVersion: null,
    });
  });

  test('reconciliationSnapshot of an unknown wallet is null', async () => {
    expect(await t.context().ledger.reconciliationSnapshot(uuid())).toBeNull();
  });

  test('reconciliationSnapshot detects a broken chain inserted as migrator', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const forgedTx = uuid();

    await db.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id, created_at,
         processed_at)
       VALUES ($1::uuid, 'provider-a', $1::text, $1::text, $2, $3, $4, 'r', 'g', 'WIN', '20.00', 'BRL', 'PROCESSED',
               'c', $5, $5)`,
      [forgedTx, hashOf(forgedTx), seeded.wallet.id, seeded.wallet.playerId, NOW],
    );
    await db.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, currency, transaction_id, direction, amount,
         balance_before, balance_after, wallet_version, created_at)
       VALUES ($1, $2, 'BRL', $3, 'CREDIT', '20.00', '50.00', '70.00', 2, $4)`,
      [uuid(), seeded.wallet.id, forgedTx, NOW],
    );

    expect(await t.context().ledger.reconciliationSnapshot(seeded.wallet.id)).toEqual({
      stored: '100.00',
      walletVersion: 1,
      calculated: '120.00',
      entries: 2,
      chainIntact: false,
      firstBrokenVersion: 2,
    });
  });

  test('reconciliationSnapshot flags a wallet version ahead of its last entry', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));

    await db.query('UPDATE wallets SET version = 3 WHERE id = $1', [seeded.wallet.id]);
    const snapshot = await t.context().ledger.reconciliationSnapshot(seeded.wallet.id);

    expect(snapshot?.chainIntact).toBe(false);
    expect(snapshot?.firstBrokenVersion).toBe(2);
  });
});

describe('WagerTransactionRepository', () => {
  test('finds by idempotency key, external id and id, scoped by provider', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '50.00' }));
    const { bet } = await t.runner().run((tx) => applyBet(tx, seeded.wallet.id));
    const ctx = t.context();

    expect(
      (await ctx.transactions.findByIdempotencyKey('provider-a', bet.idempotencyKey))?.id,
    ).toBe(bet.id);
    expect(
      await ctx.transactions.findByIdempotencyKey('provider-b', bet.idempotencyKey),
    ).toBeNull();
    expect(
      (await ctx.transactions.findByExternalId('provider-a', bet.externalTransactionId))?.id,
    ).toBe(bet.id);
    expect(
      await ctx.transactions.findByExternalId('provider-b', bet.externalTransactionId),
    ).toBeNull();
    expect(await ctx.transactions.findById(uuid())).toBeNull();
  });

  test('a REJECTED transaction keeps its failure code and observed balance', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '5.00' }));
    const bet = newWager(seeded.wallet, { money: money('10.00') });

    bet.reject({ code: FailureCode.InsufficientBalance, observedBalance: money('5.00'), at: NOW });
    await t.runner().run((tx) => tx.transactions.insert(bet));
    const read = await t.context().transactions.findById(bet.id);

    expect(read?.status).toBe(WagerStatus.Rejected);
    expect(read?.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(read?.observedBalance?.toJSON()).toEqual({ amount: '5.00', currency: 'BRL' });
  });

  test('update resolves a PENDING_REFERENCE row and refuses a row that is no longer pending', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '50.00' }));
    const refund = newWager(seeded.wallet, {
      kind: WagerKind.Refund,
      referenceExternalTransactionId: 'missing-bet',
    });

    refund.markPendingReference({
      observedBalance: money('50.00'),
      nextAttemptAt: later(1000),
      expiresAt: later(60_000),
    });
    await t.runner().run((tx) => tx.transactions.insert(refund));

    const stale = await t.context().transactions.findById(refund.id);
    const fresh = await t.context().transactions.findById(refund.id);

    if (!stale || !fresh) {
      throw new Error('pending transaction not found');
    }
    fresh.reject({
      code: FailureCode.ReferenceNotFound,
      observedBalance: money('50.00'),
      at: later(60_000),
    });
    await t.runner().run((tx) => tx.transactions.update(fresh));
    stale.scheduleRetry(later(2000));

    expect(t.context().transactions.update(stale)).rejects.toBeInstanceOf(VersionConflictError);
    expect((await t.context().transactions.findById(refund.id))?.status).toBe(WagerStatus.Rejected);
  });

  test('referenceFacts distinguishes any, effective and settling facts', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '100.00' }));
    const { bet } = await t.runner().run((tx) => applyBet(tx, seeded.wallet.id));
    const ctx = t.context();

    expect(await ctx.transactions.referenceFacts(bet)).toEqual({
      hasAnyReversal: false,
      hasEffectiveReversal: false,
      hasActiveSettlingWin: false,
    });

    const win = await insertProcessed(seeded.wallet, WagerKind.Win, bet);

    expect(await ctx.transactions.referenceFacts(bet)).toEqual({
      hasAnyReversal: false,
      hasEffectiveReversal: false,
      hasActiveSettlingWin: true,
    });

    await insertProcessed(seeded.wallet, WagerKind.Rollback, win);

    expect(await ctx.transactions.referenceFacts(bet)).toEqual({
      hasAnyReversal: false,
      hasEffectiveReversal: false,
      hasActiveSettlingWin: false,
    });

    const refund = await insertProcessed(seeded.wallet, WagerKind.Refund, bet);

    expect(await ctx.transactions.referenceFacts(bet)).toEqual({
      hasAnyReversal: true,
      hasEffectiveReversal: true,
      hasActiveSettlingWin: false,
    });

    await insertProcessed(seeded.wallet, WagerKind.Rollback, refund);

    expect(await ctx.transactions.referenceFacts(bet)).toEqual({
      hasAnyReversal: true,
      hasEffectiveReversal: false,
      hasActiveSettlingWin: false,
    });
  });

  test('accelerateDependents moves only the matching pending rows of the provider', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '50.00' }));
    const matching = await insertPending(seeded.wallet, 'provider-a', 'bet-1');
    const otherRef = await insertPending(seeded.wallet, 'provider-a', 'bet-2');
    const otherProvider = await insertPending(seeded.wallet, 'provider-b', 'bet-1');
    const accelerated = await t
      .runner()
      .run((tx) => tx.transactions.accelerateDependents('provider-a', 'bet-1', NOW));

    expect(accelerated).toBe(1);
    const ctx = t.context();

    expect((await ctx.transactions.findById(matching.id))?.nextAttemptAt).toEqual(NOW);
    expect((await ctx.transactions.findById(otherRef.id))?.nextAttemptAt).toEqual(later(60_000));
    expect((await ctx.transactions.findById(otherProvider.id))?.nextAttemptAt).toEqual(
      later(60_000),
    );
  });

  test('claimDuePending in parallel claims disjoint sets and respects active leases', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '50.00' }));
    const ids: string[] = [];

    for (let i = 0; i < 10; i++) {
      ids.push((await insertPending(seeded.wallet, 'provider-a', `bet-${i}`, NOW)).id);
    }
    const now = later(1000);
    const [a, b] = await Promise.all([
      t.context().transactions.claimDuePending({ instanceId: 'a', limit: 6, leaseMs: 30_000, now }),
      t.context().transactions.claimDuePending({ instanceId: 'b', limit: 6, leaseMs: 30_000, now }),
    ]);

    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect([...a, ...b].sort()).toEqual([...ids].sort());
    expect(
      await t
        .context()
        .transactions.claimDuePending({ instanceId: 'c', limit: 10, leaseMs: 30_000, now }),
    ).toEqual([]);
    const afterLease = await t.context().transactions.claimDuePending({
      instanceId: 'c',
      limit: 10,
      leaseMs: 30_000,
      now: later(32_000),
    });

    expect([...afterLease].sort()).toEqual([...ids].sort());
  });

  test('claimDuePending ignores rows that are not due yet', async () => {
    const seeded = await t.runner().run((tx) => seedWallet(tx, { balance: '50.00' }));

    await insertPending(seeded.wallet, 'provider-a', 'bet-x', later(60_000));

    expect(
      await t
        .context()
        .transactions.claimDuePending({ instanceId: 'a', limit: 10, leaseMs: 1000, now: NOW }),
    ).toEqual([]);
  });
});

describe('InboxRepository', () => {
  const inbox = (hash: string, messageId = 'msg-1') =>
    InboxMessage.receive({ messageId, consumerName: 'wager-consumer', payloadHash: hash, at: NOW });

  test('tryInsert reports INSERTED, DUPLICATE and PAYLOAD_CONFLICT', async () => {
    const hash = hashOf('payload');

    expect(await t.runner().run((tx) => tx.inbox.tryInsert(inbox(hash)))).toBe('INSERTED');
    expect(await t.runner().run((tx) => tx.inbox.tryInsert(inbox(hash)))).toBe('DUPLICATE');
    expect(await t.runner().run((tx) => tx.inbox.tryInsert(inbox(hashOf('other'))))).toBe(
      'PAYLOAD_CONFLICT',
    );
    expect(await t.runner().run((tx) => tx.inbox.tryInsert(inbox(hash, 'msg-2')))).toBe('INSERTED');
  });

  test('markProcessed stamps processed_at once', async () => {
    const message = inbox(hashOf('payload'));

    await t.runner().run(async (tx) => {
      await tx.inbox.tryInsert(message);
      message.markProcessed(NOW);
      await tx.inbox.markProcessed(message);
    });
    const { rows } = await db.query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM inbox_messages WHERE message_id = $1',
      ['msg-1'],
    );

    expect(rows[0]?.processed_at?.toISOString()).toBe(NOW.toISOString());
  });
});

describe('OutboxRepository', () => {
  test('claimDue returns the payload text exactly as stored, in commit (insertion) order regardless of occurredAt', async () => {
    const walletId = uuid();
    const first = outboxMessage(walletId, later(10));
    const second = outboxMessage(walletId, NOW);
    const ctx = t.context();

    await t.runner().run((tx) => tx.outbox.insertMany([first]));
    await t.runner().run((tx) => tx.outbox.insertMany([second]));
    const claimed = await ctx.outbox.claimDue({
      instanceId: 'relay-1',
      limit: 10,
      leaseMs: 30_000,
      now: later(1000),
    });

    expect(claimed.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(typeof claimed[0]?.payloadText).toBe('string');
    expect(JSON.parse(claimed[0]?.payloadText ?? 'null')).toEqual(first.payload);
    expect(claimed[0]).toMatchObject({
      partitionKey: walletId,
      eventType: 'WalletBalanceChanged',
      eventVersion: 1,
      attempts: 0,
    });
  });

  test('claimDue in parallel claims disjoint sets and skips active leases', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => outboxMessage(uuid(), later(i)));

    await t.runner().run((tx) => tx.outbox.insertMany(messages));
    const now = later(1000);
    const [a, b] = await Promise.all([
      t.context().outbox.claimDue({ instanceId: 'a', limit: 6, leaseMs: 30_000, now }),
      t.context().outbox.claimDue({ instanceId: 'b', limit: 6, leaseMs: 30_000, now }),
    ]);
    const aIds = a.map((m) => m.id);
    const bIds = b.map((m) => m.id);

    expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
    expect([...aIds, ...bIds].sort()).toEqual(messages.map((m) => m.id).sort());
    expect(
      await t.context().outbox.claimDue({ instanceId: 'c', limit: 10, leaseMs: 30_000, now }),
    ).toEqual([]);
  });

  test('markPublished removes the message from claims; scheduleRetry defers it', async () => {
    const published = outboxMessage(uuid(), NOW);
    const retried = outboxMessage(uuid(), NOW);
    const ctx = t.context();

    await t.runner().run((tx) => tx.outbox.insertMany([published, retried]));
    await ctx.outbox.claimDue({ instanceId: 'a', limit: 10, leaseMs: 30_000, now: NOW });
    await ctx.outbox.markPublished(published.id, later(5));
    await ctx.outbox.markPublished(published.id, later(9));
    await ctx.outbox.scheduleRetry(retried.id, later(5000), 1, 'x'.repeat(5000));

    expect(
      await ctx.outbox.claimDue({ instanceId: 'b', limit: 10, leaseMs: 30_000, now: later(10) }),
    ).toEqual([]);
    const due = await ctx.outbox.claimDue({
      instanceId: 'b',
      limit: 10,
      leaseMs: 30_000,
      now: later(5000),
    });

    expect(due.map((m) => [m.id, m.attempts])).toEqual([[retried.id, 1]]);
    const { rows } = await db.query<{
      id: string;
      published_at: Date | null;
      last_error: string | null;
    }>('SELECT id, published_at, last_error FROM outbox_messages ORDER BY id');
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(published.id)?.published_at?.toISOString()).toBe(later(5).toISOString());
    expect(byId.get(retried.id)?.last_error?.length).toBe(1000);
  });

  test('oldestPendingAgeSeconds measures the oldest unpublished message', async () => {
    const ctx = t.context();

    expect(await ctx.outbox.oldestPendingAgeSeconds(NOW)).toBe(0);
    const oldest = outboxMessage(uuid(), NOW);

    await t
      .runner()
      .run((tx) => tx.outbox.insertMany([oldest, outboxMessage(uuid(), later(4000))]));

    expect(await ctx.outbox.oldestPendingAgeSeconds(later(7500))).toBe(7.5);
    await ctx.outbox.markPublished(oldest.id, later(7500));

    expect(await ctx.outbox.oldestPendingAgeSeconds(later(7500))).toBe(3.5);
  });
});

describe('ProviderRegistry', () => {
  test('finds active and inactive providers; unknown ids return null', async () => {
    const ctx = t.context();

    expect(await ctx.providers.find('provider-a')).toEqual({ id: 'provider-a', active: true });
    expect(await ctx.providers.find('provider-inactive')).toEqual({
      id: 'provider-inactive',
      active: false,
    });
    expect(await ctx.providers.find('nope')).toBeNull();
  });
});

async function insertProcessed(
  wallet: Wallet,
  kind: WagerKind,
  reference: WagerTransaction,
): Promise<WagerTransaction> {
  if (kind === WagerKind.Refund) {
    return insertRefund(wallet, reference);
  }
  const tx = newWager(wallet, {
    kind,
    money: money('0.00'),
    referenceExternalTransactionId: reference.externalTransactionId,
  });

  tx.markProcessed({
    referenceTransactionId: reference.id,
    observedBalance: wallet.balance,
    at: NOW,
  });
  await t.runner().run((ctx) => ctx.transactions.insert(tx));

  return tx;
}

async function insertRefund(
  wallet: Wallet,
  reference: WagerTransaction,
): Promise<WagerTransaction> {
  return t.runner().run(async (ctx) => {
    const locked = await ctx.wallets.lockById(wallet.id);

    if (!locked) {
      throw new Error('wallet not found');
    }
    const expectedVersion = locked.version;
    const refund = newWager(locked, {
      kind: WagerKind.Refund,
      money: reference.money,
      referenceExternalTransactionId: reference.externalTransactionId,
    });
    const entry = locked.credit({
      money: refund.money,
      transactionId: refund.id,
      entryId: uuid(),
      at: NOW,
    });

    refund.markProcessed({
      referenceTransactionId: reference.id,
      observedBalance: locked.balance,
      at: NOW,
    });
    await ctx.wallets.saveBalance(locked, expectedVersion);
    await ctx.transactions.insert(refund);
    await ctx.ledger.insert(entry);

    return refund;
  });
}

async function insertPending(
  wallet: Wallet,
  providerId: string,
  referenceExternalTransactionId: string,
  nextAttemptAt = later(60_000),
): Promise<WagerTransaction> {
  const pending = newWager(wallet, {
    providerId,
    kind: WagerKind.Refund,
    referenceExternalTransactionId,
  });

  pending.markPendingReference({
    observedBalance: wallet.balance,
    nextAttemptAt,
    expiresAt: later(86_400_000),
  });
  await t.runner().run((ctx) => ctx.transactions.insert(pending));

  return pending;
}
