import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { InFlightRequests } from '../../../src/infrastructure/http/in-flight';

function request(path: string): Request {
  return { path } as Request;
}

function response(): Response & EventEmitter {
  return new EventEmitter() as Response & EventEmitter;
}

describe('InFlightRequests', () => {
  test('counts requests until they finish or close, once each, and ignores health probes', async () => {
    const tracker = new InFlightRequests();
    const middleware = tracker.middleware();
    const next: NextFunction = () => undefined;
    const a = response();
    const b = response();

    middleware(request('/wallets/1'), a, next);
    middleware(request('/wagering/transactions'), b, next);
    middleware(request('/health/ready'), response(), next);
    expect(tracker.count()).toBe(2);

    const idle = tracker.waitForIdle(1000);

    a.emit('finish');
    a.emit('close');
    expect(tracker.count()).toBe(1);
    b.emit('close');

    expect(await idle).toBe(true);
    expect(tracker.count()).toBe(0);
    expect(await tracker.waitForIdle(10)).toBe(true);
  });

  test('waitForIdle gives up after the timeout while requests are still running', async () => {
    const tracker = new InFlightRequests();

    tracker.middleware()(request('/wallets/1'), response(), () => undefined);

    expect(await tracker.waitForIdle(20)).toBe(false);
  });
});
