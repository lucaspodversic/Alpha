// EN: Reconciliation logic. / ES: Lógica de conciliación.
import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { reconcile, onchainTotals } from '../src/reconcile.js';
import { MockChain } from '../src/mock-chain.js';

describe('reconcile', () => {
  it('ok / surplus / deficit classification', () => {
    // EN: on-chain vs ledger: equal → ok, more on-chain → surplus, less on-chain → deficit (the dangerous case).
    // ES: on-chain vs ledger: igual → ok, más on-chain → excedente, menos on-chain → déficit (el caso peligroso).
    const r = reconcile({ ETH: 100n, USDT: 50n, ANX: 10n }, { ETH: 100n, USDT: 60n, ANX: 5n });
    const by = Object.fromEntries(r.lines.map((l) => [l.asset, l.status]));
    expect(by).toEqual({ ANX: 'surplus', ETH: 'ok', USDT: 'deficit' });
    expect(r.ok).toBe(false);
  });
  it('in-flight withdrawals and tolerance / retiros en vuelo y tolerancia', () => {
    // EN: 90 on-chain + 9 in flight + 1 tolerance covers the 100 owed → ok.
    // ES: 90 on-chain + 9 en tránsito + 1 de tolerancia cubren los 100 adeudados → ok.
    const r = reconcile({ ETH: 90n }, { ETH: 100n }, { inFlight: { ETH: 9n }, tolerance: { ETH: 1n } });
    expect(r.lines[0]!.status).toBe('ok');
    expect(r.ok).toBe(true);
  });
  it('sums balances across addresses / suma saldos entre direcciones', async () => {
    const c = new MockChain();
    const a = '0x0000000000000000000000000000000000000001' as Address;
    const b = '0x0000000000000000000000000000000000000002' as Address;
    c.setBalance('ETH', a, 3n);
    c.mine([{ asset: 'ETH', to: b, amount: 4n }]);
    expect(await onchainTotals(c, [a, b], [{ code: 'ETH', kind: 'native' }])).toEqual({ ETH: 7n });
  });
});
