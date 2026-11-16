import { describe, expect, test } from 'bun:test';
import { startGate } from '../../support/builders';
import { repeated, useCaseHarness } from '../../support/harness';
import { wagerCommand } from '../../support/use-cases';

const h = useCaseHarness();

describe('two different BETs of 80.00 race for a balance of 100.00', () => {
  for (const name of repeated('one is PROCESSED, the other REJECTED INSUFFICIENT_BALANCE')) {
    test(name, async () => {
      const wallet = await h.openWallet('100.00');
      const gate = startGate();
      const runs = [1, 2].map(async () => {
        await gate.wait();

        return h.app.processWager.execute(
          wagerCommand(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
          { type: 'HTTP' },
        );
      });

      gate.release();
      const statuses = (await Promise.all(runs)).map((r) =>
        r.type === 'RESULT' ? `${r.view.status}:${r.view.failureCode ?? ''}` : r.type,
      );

      expect(statuses.sort()).toEqual(['PROCESSED:', 'REJECTED:INSUFFICIENT_BALANCE']);
      expect((await h.app.getWallet.execute(wallet.id))?.balance.amount).toBe('20.00');
      expect(await h.count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(1);
    });
  }
});
