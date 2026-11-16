import { describe, expect, test } from 'bun:test';
import { startGate } from '../../support/builders';
import { repeated, useCaseHarness } from '../../support/harness';
import { wagerCommand } from '../../support/use-cases';
import { WagerKind } from '../../../src/modules/wagering/domain/wager-kind';

const h = useCaseHarness();

describe('a REFUND and a ROLLBACK of the same BET race', () => {
  for (const name of repeated('exactly one is PROCESSED, the other ALREADY_REVERSED')) {
    test(name, async () => {
      const wallet = await h.openWallet('100.00');
      const bet = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });

      await h.app.processWager.execute(bet, { type: 'HTTP' });
      const gate = startGate();
      const runs = [WagerKind.Refund, WagerKind.Rollback].map(async (kind) => {
        await gate.wait();

        return h.app.processWager.execute(
          wagerCommand(wallet, {
            kind,
            money: { amount: '30.00', currency: 'BRL' },
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
          { type: 'HTTP' },
        );
      });

      gate.release();
      const outcomes = (await Promise.all(runs)).map((r) =>
        r.type === 'RESULT' ? `${r.view.status}:${r.view.failureCode ?? ''}` : r.type,
      );

      expect(outcomes.sort()).toEqual(['PROCESSED:', 'REJECTED:ALREADY_REVERSED']);
      expect((await h.app.getWallet.execute(wallet.id))?.balance.amount).toBe('100.00');
      expect(await h.count('wallet_ledger_entries', "direction = 'CREDIT'")).toBe(2);
    });
  }
});
