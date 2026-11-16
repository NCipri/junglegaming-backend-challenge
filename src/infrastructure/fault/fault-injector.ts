// Fault injection points for crash tests; production uses the no-op injector.
export type FaultPoint =
  | 'after-ledger-insert'
  | 'before-commit'
  | 'after-commit-before-ack'
  | 'after-claim-before-publish'
  | 'after-publish-before-mark';

export interface FaultInjector {
  hit(point: FaultPoint): Promise<void>;
}

export class FaultInjectedError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`Fault injected at ${point}`);
    this.name = 'FaultInjectedError';
  }
}

export class NoopFaultInjector implements FaultInjector {
  hit(): Promise<void> {
    return Promise.resolve();
  }
}

export class ProcessKillFaultInjector implements FaultInjector {
  constructor(private readonly point: FaultPoint | null) {}

  hit(point: FaultPoint): Promise<void> {
    if (this.point === point) {
      process.kill(process.pid, 'SIGKILL');
    }

    return Promise.resolve();
  }
}
