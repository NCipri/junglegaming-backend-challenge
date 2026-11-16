import { describe, expect, test } from 'bun:test';
import { startGate } from '../../support/builders';
import { repeated, useCaseHarness } from '../../support/harness';
import { wagerCommand } from '../../support/use-cases';
import { WagerStatus } from '../../../src/modules/wagering/domain/wager-status';

const h = useCaseHarness();
const WALLETS = 20;
const BETS = 10;

async function openWallets() {
  return Promise.all(Array.from({ length: WALLETS }, () => h.openWallet('100.00')));
}

describe('distinct wallets are processed in parallel', () => {
  for (const name of repeated(
    '20 wallets × 10 BETs keep every invariant and run faster than in sequence',
  )) {
    test(
      name,
      async () => {
        const sequentialWallets = await openWallets();
        const sequentialStart = performance.now();

        for (const wallet of sequentialWallets) {
          for (let i = 0; i < BETS; i++) {
            await h.app.processWager.execute(
              wagerCommand(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
              { type: 'HTTP' },
            );
          }
        }
        const sequentialMs = performance.now() - sequentialStart;
        const parallelWallets = await openWallets();
        const gate = startGate();
        const runs = parallelWallets.flatMap((wallet) =>
          Array.from({ length: BETS }, async () => {
            await gate.wait();

            return h.app.processWager.execute(
              wagerCommand(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
              { type: 'HTTP' },
            );
          }),
        );
        const parallelStart = performance.now();

        gate.release();
        const results = await Promise.all(runs);
        const parallelMs = performance.now() - parallelStart;

        expect(
          results.every((r) => r.type === 'RESULT' && r.view.status === WagerStatus.Processed),
        ).toBe(true);
        for (const wallet of parallelWallets) {
          expect((await h.app.getWallet.execute(wallet.id))?.balance.amount).toBe('90.00');
        }
        expect(parallelMs).toBeLessThan(sequentialMs);
      },
      60_000,
    );
  }
});
