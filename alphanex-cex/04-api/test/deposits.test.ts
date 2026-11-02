// EN: Deposits through the real watcher on a mock chain: addresses, confirmations, reorg policy, reconciliation.
// ES: Depósitos con el watcher real sobre una cadena simulada: direcciones, confirmaciones, política de reorg, conciliación.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseEther, type Address } from 'viem';
import { DepositWatcher, MockChain } from '@alphanex/custody';
import { makeApp, call, user, balances, randomXpub, PW } from './helpers.js';

const USDT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
let h: Awaited<ReturnType<typeof makeApp>>;
let chain: MockChain;
let watcher: DepositWatcher;
let dave: { token: string; id: string };
let admin: string;

beforeAll(async () => {
  chain = new MockChain();
  h = await makeApp(
    { DEPOSIT_XPUB: randomXpub(), USDT_CONTRACT: USDT, CONFIRMATIONS_ETH: '3', CONFIRMATIONS_USDT: '3' },
    { chain, bootstrapAdmins: [{ email: 'root@example.com', password: PW }] },
  );
  watcher = new DepositWatcher({ chain, sink: h.services.deposits.sink(), store: h.services.deposits.store(), assets: h.services.watched });
  dave = await user(h.app, 'dave@example.com');
  admin = (await call(h.app, 'POST', '/auth/login', { body: { email: 'root@example.com', password: PW } })).json.token;
});
afterAll(async () => {
  await h.app.close();
  await h.db.close();
});

describe('deposits', () => {
  it('assigns one stable HD address per user / asigna una dirección HD estable por usuario', async () => {
    const a = await call(h.app, 'GET', '/account/deposit-address', { token: dave.token });
    const b = await call(h.app, 'GET', '/account/deposit-address', { token: dave.token });
    expect(a.json.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // EN: Asking twice returns the same address (stored, not re-derived with a new index).
    // ES: Pedirla dos veces devuelve la misma dirección (guardada, no re-derivada con otro índice).
    expect(b.json.address).toBe(a.json.address);
    expect(a.json.assets.map((x: { code: string }) => x.code).sort()).toEqual(['ETH', 'USDT']);
    const other = await user(h.app, 'erin@example.com');
    expect((await call(h.app, 'GET', '/account/deposit-address', { token: other.token })).json.address).not.toBe(a.json.address);
  });

  it('credits only after N confirmations, exactly once / acredita solo tras N confirmaciones, exactamente una vez', async () => {
    const addr = (await call(h.app, 'GET', '/account/deposit-address', { token: dave.token })).json.address as Address;
    // EN: MockChain: deterministic in-memory chain (no network) with mine / reorg helpers.
    // ES: MockChain: cadena determinística en memoria (sin red) con helpers de minado / reorg.
    chain.mine([
      { asset: 'ETH', to: addr, amount: parseEther('1.5') },
      { asset: 'USDT', to: addr, amount: 250_000_000n },
    ]);
    await watcher.poll();
    expect((await call(h.app, 'GET', '/account/deposits', { token: dave.token })).json.deposits.every((d: { status: string }) => d.status === 'pending')).toBe(true);
    // EN: Seen with 1 confirmation → pending, nothing credited yet.
    // ES: Visto con 1 confirmación → pendiente, todavía nada acreditado.
    expect((await balances(h.app, dave.token)).ETH.available).toBe('0');
    chain.mineEmpty(3);
    await watcher.poll();
    await watcher.poll();
    const bal = await balances(h.app, dave.token);
    // EN: The watcher polled twice above: credited exactly once (idempotent by deposit id).
    // ES: El watcher hizo poll dos veces arriba: se acreditó exactamente una vez (idempotente por id de depósito).
    expect(bal.ETH.available).toBe('1.5');
    expect(bal.USDT.available).toBe('250');
    // EN: Reconciliation: on-chain == custody ledger. / ES: Conciliación: on-chain == ledger de custodia.
    const rec = await call(h.app, 'POST', '/admin/reconcile', { token: admin });
    expect(rec.json.ok).toBe(true);
    expect(rec.json.human.find((l: { asset: string }) => l.asset === 'ETH')).toMatchObject({ onchain: '1.5', ledger: '1.5', diff: '0' });
  });

  it('a reorg deeper than the confirmation depth freezes the user and alerts (no silent reversal) / un reorg más profundo que las confirmaciones congela al usuario y alerta (sin reversión silenciosa)', async () => {
    const addr = (await call(h.app, 'GET', '/account/deposit-address', { token: dave.token })).json.address as Address;
    chain.mine([{ asset: 'ETH', to: addr, amount: parseEther('2') }]);
    chain.mineEmpty(3);
    await watcher.poll();
    expect((await balances(h.app, dave.token)).ETH.available).toBe('3.5');
    // EN: Dave immediately trades the funds. / ES: Dave opera los fondos inmediatamente.
    await call(h.app, 'POST', '/orders', { token: dave.token, body: { market: 'ETH-USDT', side: 'sell', type: 'limit', price: '3000', qty: '3' } });
    const alerts: unknown[] = [];
    const off = h.services.bus.subscribe('admin', (m) => alerts.push(m));
    // EN: Drop the last 5 blocks (deeper than 3 confirmations) and build a longer chain without the deposit.
    // ES: Descartar los últimos 5 bloques (más que 3 confirmaciones) y construir una cadena más larga sin el depósito.
    chain.reorg(5);
    chain.mineEmpty(6);
    await watcher.poll();
    off();
    const deps = (await call(h.app, 'GET', '/account/deposits', { token: dave.token })).json.deposits;
    expect(deps.some((d: { status: string }) => d.status === 'reorged_after_credit')).toBe(true);
    const me = (await call(h.app, 'GET', '/auth/me', { token: dave.token })).json.user;
    // EN: Response to a critical reorg: user frozen, open orders canceled (holds released), alert emitted.
    // ES: Respuesta a un reorg crítico: usuario congelado, órdenes canceladas (retenciones liberadas), alerta emitida.
    expect(me.frozen).toBe(true);
    expect((await call(h.app, 'GET', '/orders?open=true', { token: dave.token })).json.orders).toHaveLength(0);
    expect(alerts.length).toBeGreaterThan(0);
    // EN: Reconciliation now shows the deficit for ops to resolve. / ES: La conciliación muestra el déficit para que ops lo resuelva.
    const rec = await call(h.app, 'POST', '/admin/reconcile', { token: admin });
    expect(rec.json.ok).toBe(false);
    expect((await call(h.app, 'GET', '/admin/invariants', { token: admin })).json.ok).toBe(true);
    // EN: The deficit automatically halted ALL withdrawals (kill switch), even for unaffected users.
    // ES: El déficit detuvo automáticamente TODOS los retiros (interruptor), incluso para usuarios no afectados.
    const halt = (await call(h.app, 'GET', '/admin/withdrawals/halt', { token: admin })).json;
    expect(halt.halted).toBe(true);
    expect(halt.reason).toMatch(/ETH/);
    const frank = await user(h.app, 'frank@example.com');
    await call(h.app, 'POST', '/dev/faucet', { token: frank.token, body: { asset: 'USDT', amount: '100' } });
    const w = await call(h.app, 'POST', '/account/withdrawals', {
      token: frank.token,
      headers: { 'idempotency-key': 'halt-test-0001' },
      body: { asset: 'USDT', to: '0x000000000000000000000000000000000000dEaD', amount: '10' },
    });
    expect(w.status).toBe(403);
    expect(w.json.error).toBe('withdrawals_halted');
    // EN: Resuming is an explicit, audited admin action. / ES: Reanudar es una acción explícita y auditada de un admin.
    const res = await call(h.app, 'POST', '/admin/withdrawals/halt', { token: admin, body: { halted: false, reason: 'deficit explained, reversal booked' } });
    expect(res.json.halted).toBe(false);
    const audit = (await call(h.app, 'GET', '/admin/audit?action=withdrawals.resume', { token: admin })).json.entries;
    expect(audit).toHaveLength(1);
  });
});
