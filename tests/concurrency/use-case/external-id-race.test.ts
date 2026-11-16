import { describe, expect, test } from 'bun:test';
import { startGate } from '../../support/builders';
import { repeated, useCaseHarness } from '../../support/harness';
import { wagerCommand } from '../../support/use-cases';

const h = useCaseHarness();

describe('two idempotency keys race with the same external id', () => {
  for (const name of repeated('one RESULT and one EXTERNAL_ID_CONFLICT')) {
    test(name, async () => {
      const wallet = await h.openWallet('100.00');
      const cmd = wagerCommand(wallet);
      const gate = startGate();
      const runs = ['key-a', 'key-b'].map(async (idempotencyKey) => {
        await gate.wait();

        return h.app.processWager.execute({ ...cmd, idempotencyKey }, { type: 'HTTP' });
      });

      gate.release();
      const types = (await Promise.all(runs)).map((r) => r.type).sort();

      expect(types).toEqual(['EXTERNAL_ID_CONFLICT', 'RESULT']);
      expect(await h.count('wager_transactions', "kind = 'BET'")).toBe(1);
      expect((await h.app.getWallet.execute(wallet.id))?.balance.amount).toBe('75.00');
    });
  }
});
