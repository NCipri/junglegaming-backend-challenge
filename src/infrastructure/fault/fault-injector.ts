// Fault injection for crash tests (FAULT_INJECTION=<point> kills, <point>:throw throws); production uses the no-op injector.
export type FaultPoint =
  | 'after-ledger-insert'
  | 'before-commit'
  | 'after-commit-before-ack'
  | 'after-claim-before-publish'
  | 'after-publish-before-mark'
  | 'during-shutdown';

export const FAULT_POINTS: readonly FaultPoint[] = [
  'after-ledger-insert',
  'before-commit',
  'after-commit-before-ack',
  'after-claim-before-publish',
  'after-publish-before-mark',
  'during-shutdown',
];

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

export class FailingFaultInjector implements FaultInjector {
  constructor(private readonly point: FaultPoint) {}

  hit(point: FaultPoint): Promise<void> {
    return point === this.point ? Promise.reject(new FaultInjectedError(point)) : Promise.resolve();
  }
}

export function parseFaultInjection(value: string | undefined): FaultInjector {
  const [name, mode] = (value ?? '').split(':');
  const point = FAULT_POINTS.find((candidate) => candidate === name);

  if (!point) {
    return new NoopFaultInjector();
  }

  return mode === 'throw' ? new FailingFaultInjector(point) : new ProcessKillFaultInjector(point);
}
