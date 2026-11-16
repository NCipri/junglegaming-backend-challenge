// Counts in-flight HTTP requests (health probes excluded) so shutdown can drain them before closing the listener.
import type { NextFunction, Request, Response } from 'express';

export class InFlightRequests {
  private active = 0;
  private waiters: (() => void)[] = [];

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (req.path.startsWith('/health/')) {
        next();

        return;
      }
      this.active += 1;
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        this.active -= 1;
        if (this.active === 0) {
          this.waiters.splice(0).forEach((resolve) => resolve());
        }
      };

      res.on('finish', finish);
      res.on('close', finish);
      next();
    };
  }

  count(): number {
    return this.active;
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);

      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
