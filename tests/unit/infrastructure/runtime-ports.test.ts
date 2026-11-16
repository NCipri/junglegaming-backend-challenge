import { describe, expect, test } from 'bun:test';
import {
  FaultInjectedError,
  NoopFaultInjector,
  parseFaultInjection,
  ProcessKillFaultInjector,
} from '../../../src/infrastructure/fault/fault-injector';
import { createSqsClient } from '../../../src/modules/messaging/infrastructure/sqs-client';
import { DlqDepthCollector } from '../../../src/modules/observability/dlq-depth.collector';
import { NoopLogger, type AppLogger } from '../../../src/modules/observability/logger.port';
import { captureLogs } from '../../support/log-capture';
import { InMemoryMetrics } from '../../support/metrics';

describe('fault injectors', () => {
  test('the no-op injector and a kill injector for another point never interrupt', async () => {
    expect(await new NoopFaultInjector().hit()).toBeUndefined();
    expect(await new ProcessKillFaultInjector(null).hit('before-commit')).toBeUndefined();
    expect(
      await new ProcessKillFaultInjector('after-commit-before-ack').hit('before-commit'),
    ).toBeUndefined();
  });
});

describe('loggers', () => {
  test('NoopLogger accepts every level', () => {
    const logger: AppLogger = new NoopLogger();

    logger.info({}, 'i');
    logger.warn({}, 'w');
    logger.error({}, 'e');

    expect(logger).toBeInstanceOf(NoopLogger);
  });

  test('the pino logger writes warn and error lines as JSON with their levels', () => {
    const capture = captureLogs();

    capture.logger.warn({ walletId: 'w-1' }, 'careful');
    capture.logger.error({ walletId: 'w-1' }, 'broken');

    expect(capture.entries().map((entry) => [entry['level'], entry['msg']])).toEqual([
      [40, 'careful'],
      [50, 'broken'],
    ]);
  });
});

describe('DlqDepthCollector', () => {
  test('an unreachable SQS is logged and leaves the gauge untouched', async () => {
    const metrics = new InMemoryMetrics();
    const capture = captureLogs();
    const client = createSqsClient({
      endpoint: 'http://127.0.0.1:1',
      region: 'us-east-1',
      connectTimeoutMs: 200,
      requestTimeoutMs: 200,
    });
    const collector = new DlqDepthCollector(
      client,
      'http://127.0.0.1:1/000000000000/dlq.fifo',
      metrics,
      capture.logger,
      {
        intervalMs: 10_000,
        timeoutMs: 500,
      },
    );

    collector.start();
    collector.stop();
    await collector.collect();
    client.destroy();

    expect(metrics.gauge('dlq_depth')).toBeUndefined();
    expect(capture.entries().some((entry) => entry['msg'] === 'DLQ depth read failed')).toBe(true);
  });
});

describe('parseFaultInjection', () => {
  test('no value or an unknown point gives the no-op injector', async () => {
    expect(parseFaultInjection(undefined)).toBeInstanceOf(NoopFaultInjector);
    expect(parseFaultInjection('nowhere')).toBeInstanceOf(NoopFaultInjector);
    expect(parseFaultInjection('nowhere:throw')).toBeInstanceOf(NoopFaultInjector);
    expect(await parseFaultInjection(undefined).hit('before-commit')).toBeUndefined();
  });

  test('a bare point kills the process; "<point>:throw" throws at that point only', async () => {
    expect(parseFaultInjection('after-commit-before-ack')).toBeInstanceOf(ProcessKillFaultInjector);
    const throwing = parseFaultInjection('during-shutdown:throw');

    expect(await throwing.hit('before-commit')).toBeUndefined();
    let caught: unknown = null;

    try {
      await throwing.hit('during-shutdown');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FaultInjectedError);
  });
});
