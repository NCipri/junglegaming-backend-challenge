// ProcessWagerTransaction: per-channel order, idempotent replay, locked processing and FAILED recording for deterministic errors.
import { classifyError } from '../../../infrastructure/db/error-classification';
import type { TxContext } from '../../../infrastructure/db/tx-context';
import type { WalletTransactionRunner } from '../../../infrastructure/db/wallet-transaction-runner';
import type { FaultInjector } from '../../../infrastructure/fault/fault-injector';
import type { IdGenerator } from '../../../shared/ids/id-generator';
import { Money } from '../../../shared/money/money';
import type { Clock } from '../../../shared/time/clock';
import type { EventFactory } from '../../messaging/domain/event-factory';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import type { MetricsPort } from '../../observability/metrics.port';
import { FailureCode } from '../domain/failure-code';
import { computeWagerPayloadHash } from '../domain/payload-hash';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerChannel, WagerCommand } from './wager-command';
import type { WagerProcessor } from './wager-processor';
import { toTransactionView, type WagerResult } from './wager-result';

type SqsChannel = Extract<WagerChannel, { type: 'SQS' }>;

export class ProcessWagerTransaction {
  constructor(
    private readonly runner: WalletTransactionRunner,
    private readonly processor: WagerProcessor,
    private readonly events: EventFactory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: MetricsPort,
    private readonly faults: FaultInjector,
  ) {}

  async execute(
    cmd: WagerCommand,
    channel: WagerChannel,
    opts: { signal?: AbortSignal } = {},
  ): Promise<WagerResult> {
    const startedAt = performance.now();
    const payloadHash = computeWagerPayloadHash({
      ...cmd,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId ?? null,
    });
    const transactionId = this.ids.next();
    const build = () => this.buildPending(cmd, payloadHash, transactionId);

    build();
    try {
      if (channel.type === 'HTTP') {
        const existing = await this.runner.read((tx) =>
          tx.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey),
        );

        if (existing) {
          return this.replay(existing, payloadHash, channel);
        }
      }

      return await this.runner.run(
        (tx) => this.unit(tx, cmd, channel, payloadHash, build),
        opts.signal ? { signal: opts.signal } : {},
      );
    } catch (error) {
      if (opts.signal?.aborted || classifyError(error).kind !== 'DETERMINISTIC') {
        throw error;
      }

      return this.recordFailure(cmd, channel, payloadHash, build);
    } finally {
      this.metrics.observe('processing_duration_seconds', (performance.now() - startedAt) / 1000, {
        channel: channel.type,
      });
    }
  }

  private async unit(
    tx: TxContext,
    cmd: WagerCommand,
    channel: WagerChannel,
    payloadHash: string,
    build: () => WagerTransaction,
  ): Promise<WagerResult> {
    const inbox = channel.type === 'SQS' ? this.inboxMessage(channel) : null;

    if (inbox) {
      const outcome = await tx.inbox.tryInsert(inbox);

      if (outcome === 'DUPLICATE') {
        this.metrics.increment('inbox_duplicates_total');

        return { type: 'INBOX_DUPLICATE' };
      }
      if (outcome === 'PAYLOAD_CONFLICT') {
        this.metrics.increment('inbox_payload_conflict_total');

        return { type: 'INBOX_PAYLOAD_CONFLICT' };
      }
    }
    const result = await this.lockedUnit(tx, cmd, channel, payloadHash, build);

    if (inbox) {
      inbox.markProcessed(this.clock.now());
      await tx.inbox.markProcessed(inbox);
    }
    await this.faults.hit('before-commit');

    return result;
  }

  private async lockedUnit(
    tx: TxContext,
    cmd: WagerCommand,
    channel: WagerChannel,
    payloadHash: string,
    build: () => WagerTransaction,
  ): Promise<WagerResult> {
    if (channel.type === 'SQS') {
      const early = await tx.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);

      if (early) {
        return this.replay(early, payloadHash, channel);
      }
    }
    const wallet = await tx.wallets.lockById(cmd.walletId);
    const existing = await tx.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);

    if (existing) {
      return this.replay(existing, payloadHash, channel);
    }
    if (await tx.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId)) {
      return { type: 'EXTERNAL_ID_CONFLICT' };
    }
    const view = await this.processor.processLocked(tx, build(), {
      wallet,
      correlationId: cmd.correlationId,
      ...(channel.type === 'SQS' ? { causationId: channel.messageId } : {}),
    });

    return { type: 'RESULT', view, replay: false };
  }

  private async recordFailure(
    cmd: WagerCommand,
    channel: WagerChannel,
    payloadHash: string,
    build: () => WagerTransaction,
  ): Promise<WagerResult> {
    return this.runner.run(async (tx) => {
      const existing = await tx.transactions.findByIdempotencyKey(
        cmd.providerId,
        cmd.idempotencyKey,
      );

      if (existing) {
        return this.replay(existing, payloadHash, channel);
      }
      if (await tx.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId)) {
        return { type: 'EXTERNAL_ID_CONFLICT' };
      }
      const failed = build();

      failed.fail({ code: FailureCode.UnexpectedProcessingError, at: this.clock.now() });
      await tx.transactions.insert(failed);
      await tx.outbox.insertMany(
        this.events.forFailed(failed, {
          correlationId: cmd.correlationId,
          ...(channel.type === 'SQS' ? { causationId: channel.messageId } : {}),
        }),
      );
      this.metrics.increment('wager_transactions_total', {
        status: failed.status,
        kind: failed.kind,
      });

      return { type: 'RESULT', view: toTransactionView(failed), replay: false };
    });
  }

  private replay(
    existing: WagerTransaction,
    payloadHash: string,
    channel: WagerChannel,
  ): WagerResult {
    if (!existing.matchesPayload(payloadHash)) {
      return { type: 'IDEMPOTENCY_CONFLICT' };
    }
    this.metrics.increment('idempotent_replays_total', { channel: channel.type });

    return { type: 'RESULT', view: toTransactionView(existing), replay: true };
  }

  private inboxMessage(channel: SqsChannel): InboxMessage {
    return InboxMessage.receive({
      messageId: channel.messageId,
      consumerName: channel.consumerName,
      payloadHash: channel.messageHash,
      at: this.clock.now(),
    });
  }

  private buildPending(cmd: WagerCommand, payloadHash: string, id: string): WagerTransaction {
    return WagerTransaction.create({
      id,
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: Money.from(cmd.money),
      ...(cmd.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: cmd.referenceExternalTransactionId }
        : {}),
      correlationId: cmd.correlationId,
      createdAt: this.clock.now(),
    });
  }
}
