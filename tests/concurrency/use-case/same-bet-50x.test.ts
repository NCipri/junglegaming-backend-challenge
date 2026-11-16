import { describe, expect, test } from 'bun:test';
import { startGate } from '../../support/builders';
import { repeated, useCaseHarness } from '../../support/harness';
import { wagerCommand } from '../../support/use-cases';

const h = useCaseHarness();

describe('the same BET sent 50 times in parallel', () => {
  for (const name of repeated('debits exactly once; 49 replays return the same result')) {
    test(
      name,
      async () => {
        const wallet = await h.openWallet('1000.00');
        const cmd = wagerCommand(wallet);
        const gate = startGate();
        const runs = Array.from({ length: 50 }, async () => {
          await gate.wait();

          return h.app.processWager.execute(cmd, { type: 'HTTP' });
        });

        gate.release();
        const results = await Promise.all(runs);
        const views = results.map((r) => {
          if (r.type !== 'RESULT') {
            throw new Error(`unexpected ${r.type}`);
          }

          return r;
        });

        expect(views.filter((r) => !r.replay)).toHaveLength(1);
        expect(views.filter((r) => r.replay)).toHaveLength(49);
        expect(new Set(views.map((r) => r.view.transactionId)).size).toBe(1);
        expect(views.every((r) => r.view.balance?.amount === '975.00')).toBe(true);
        expect(await h.count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(1);
        expect((await h.app.getWallet.execute(wallet.id))?.balance.amount).toBe('975.00');
      },
      30_000,
    );
  }
});
