/**
 * EN: Exchange accounting flows end-to-end on the ledger: trade settlement with fees,
 *     withdrawals (reserve/complete/refund with gas), custody moves and a randomized
 *     property test asserting that books always balance and custody == liabilities + revenue − expenses.
 * ES: Flujos contables del exchange de punta a punta sobre el ledger: liquidación con fees,
 *     retiros (reserva/completar/devolver con gas), movimientos de custodia y un test de propiedad
 *     aleatorio que verifica que los libros siempre cierran y custodia == pasivos + ingresos − gastos.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { InsufficientFundsError } from '../src/index.js';
import { setup } from './helpers.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
});

describe('trade settlement / liquidación', () => {
  it('EN: moves both legs and fees exactly / ES: mueve ambas patas y fees exactas', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction(async (tx) => {
      await acct.creditDeposit(tx, { userId: 'B', asset: 'USDT', amount: 10_000n, eventId: 'd1' });
      await acct.creditDeposit(tx, { userId: 'S', asset: 'ETH', amount: 5_000n, eventId: 'd2' });
      await acct.hold(tx, { userId: 'B', asset: 'USDT', amount: 2_000n, orderId: 'b1' });
      await acct.hold(tx, { userId: 'S', asset: 'ETH', amount: 1_000n, orderId: 's1' });
      await acct.settleTrade(tx, { id: 'ETH-USDT:1', base: 'ETH', quote: 'USDT', qty: 1_000n, quoteQty: 2_000n, buyerUserId: 'B', sellerUserId: 'S', buyerFee: 2n, sellerFee: 4n });
    });
    expect(await ledger.userBalances('B')).toEqual({ USDT: { available: 8_000n, locked: 0n, withdrawing: 0n }, ETH: { available: 998n, locked: 0n, withdrawing: 0n } });
    expect(await ledger.userBalances('S')).toEqual({ ETH: { available: 4_000n, locked: 0n, withdrawing: 0n }, USDT: { available: 1_996n, locked: 0n, withdrawing: 0n } });
    expect(await ledger.balance('fees:ETH')).toBe(2n);
    expect(await ledger.balance('fees:USDT')).toBe(4n);
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });

  it('EN: zero fees are allowed (no zero postings) / ES: se permiten fees en cero (sin movimientos en cero)', async () => {
    const { db, acct, ledger } = await setup();
    cleanup = () => db.close();
    await db.transaction(async (tx) => {
      await acct.creditDeposit(tx, { userId: 'B', asset: 'USDT', amount: 10n, eventId: 'd1' });
      await acct.creditDeposit(tx, { userId: 'S', asset: 'ETH', amount: 10n, eventId: 'd2' });
      await acct.hold(tx, { userId: 'B', asset: 'USDT', amount: 10n, orderId: 'b' });
      await acct.hold(tx, { userId: 'S', asset: 'ETH', amount: 10n, orderId: 's' });
      await acct.settleTrade(tx, { id: 't', base: 'ETH', quote: 'USDT', qty: 10n, quoteQty: 10n, buyerUserId: 'B', sellerUserId: 'S', buyerFee: 0n, sellerFee: 0n });
    });
    expect(await ledger.balance('fees:USDT')).toBe(0n);
  });

  it('EN: settlement cannot spend more than locked / ES: la liquidación no puede gastar más de lo retenido', async () => {
    const { db, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction(async (tx) => {
      await acct.creditDeposit(tx, { userId: 'B', asset: 'USDT', amount: 100n, eventId: 'd1' });
      await acct.creditDeposit(tx, { userId: 'S', asset: 'ETH', amount: 100n, eventId: 'd2' });
      await acct.hold(tx, { userId: 'B', asset: 'USDT', amount: 50n, orderId: 'b' });
      await acct.hold(tx, { userId: 'S', asset: 'ETH', amount: 100n, orderId: 's' });
    });
    await expect(
      db.transaction((tx) => acct.settleTrade(tx, { id: 't', base: 'ETH', quote: 'USDT', qty: 10n, quoteQty: 60n, buyerUserId: 'B', sellerUserId: 'S', buyerFee: 0n, sellerFee: 0n })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });
});

describe('withdrawals / retiros', () => {
  it('EN: reserve → complete with fee and gas / ES: reservar → completar con fee y gas', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction(async (tx) => {
      await acct.creditDeposit(tx, { userId: 'u', asset: 'USDT', amount: 1_000n, eventId: 'd1' });
      await acct.creditDeposit(tx, { userId: 'ops', asset: 'ETH', amount: 1_000n, eventId: 'd2' });
      await acct.reserveWithdrawal(tx, { userId: 'u', asset: 'USDT', amount: 900n, fee: 10n, withdrawalId: 'w1' });
    });
    expect(await ledger.balance('user:u:USDT:withdrawing')).toBe(910n);
    await db.transaction((tx) => acct.completeWithdrawal(tx, { userId: 'u', asset: 'USDT', amount: 900n, fee: 10n, withdrawalId: 'w1', gasCost: 21n }));
    expect(await ledger.balance('user:u:USDT:available')).toBe(90n);
    expect(await ledger.balance('custody:hot:USDT')).toBe(100n);
    expect(await ledger.balance('fees:USDT')).toBe(10n);
    expect(await ledger.balance('expense:gas:ETH')).toBe(21n);
    expect(await ledger.balance('custody:hot:ETH')).toBe(979n);
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });

  it('EN: refund restores available / ES: la devolución restaura el disponible', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction(async (tx) => {
      await acct.creditDeposit(tx, { userId: 'u', asset: 'USDT', amount: 1_000n, eventId: 'd1' });
      await acct.reserveWithdrawal(tx, { userId: 'u', asset: 'USDT', amount: 500n, fee: 5n, withdrawalId: 'w1' });
      await acct.refundWithdrawal(tx, { userId: 'u', asset: 'USDT', amount: 500n, fee: 5n, withdrawalId: 'w1' });
    });
    expect(await ledger.balance('user:u:USDT:available')).toBe(1_000n);
  });

  it('EN: hot → cold move keeps total custody / ES: mover hot → cold mantiene la custodia total', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction(async (tx) => {
      await acct.creditDeposit(tx, { userId: 'u', asset: 'ETH', amount: 1_000n, eventId: 'd1' });
      await acct.moveCustody(tx, { asset: 'ETH', amount: 700n, from: 'hot', to: 'cold', ref: 'sweep-1' });
    });
    expect(await ledger.totalsByOwnerType('custody')).toEqual({ ETH: 1_000n });
    expect(await ledger.balance('custody:cold:ETH')).toBe(700n);
  });

  it('EN: deposit reversal fails if user already spent funds / ES: la reversa falla si el usuario ya gastó', async () => {
    const { db, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction(async (tx) => {
      await acct.creditDeposit(tx, { userId: 'u', asset: 'ETH', amount: 100n, eventId: 'd1' });
      await acct.hold(tx, { userId: 'u', asset: 'ETH', amount: 60n, orderId: 'o' });
    });
    await expect(db.transaction((tx) => acct.reverseDeposit(tx, { userId: 'u', asset: 'ETH', amount: 100n, eventId: 'd1' }))).rejects.toBeInstanceOf(InsufficientFundsError);
  });
});

describe('property: random flows keep books balanced / propiedad: flujos aleatorios mantienen libros cerrados', () => {
  it('EN: custody == user liabilities + fees − gas expense, per asset / ES: custodia == pasivos + fees − gas, por activo', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    const op = fc.record({
      kind: fc.constantFrom('dep', 'hold', 'release', 'wd', 'trade'),
      user: fc.constantFrom('a', 'b', 'c'),
      other: fc.constantFrom('a', 'b', 'c'),
      amt: fc.bigInt({ min: 1n, max: 1_000n }),
    });
    const flows = fc.sample(fc.array(op, { minLength: 30, maxLength: 60 }), { numRuns: 3, seed: 42 });
    let i = 0;
    for (const flow of flows) {
      for (const o of flow) {
        i++;
        // EN: Each op in its own transaction; overdrafts are expected and must roll back cleanly.
        // ES: Cada operación en su transacción; se esperan sobregiros y deben revertirse limpio.
        await db
          .transaction(async (tx) => {
            if (o.kind === 'dep') await acct.creditDeposit(tx, { userId: o.user, asset: 'USDT', amount: o.amt, eventId: `e${i}` });
            if (o.kind === 'hold') await acct.hold(tx, { userId: o.user, asset: 'USDT', amount: o.amt, orderId: `o${i}` });
            if (o.kind === 'release') await acct.release(tx, { userId: o.user, asset: 'USDT', amount: o.amt, orderId: `o${i}`, reason: 'cancel' });
            if (o.kind === 'wd') {
              await acct.reserveWithdrawal(tx, { userId: o.user, asset: 'USDT', amount: o.amt, fee: 1n, withdrawalId: `w${i}` });
              await acct.completeWithdrawal(tx, { userId: o.user, asset: 'USDT', amount: o.amt, fee: 1n, withdrawalId: `w${i}` });
            }
            if (o.kind === 'trade' && o.user !== o.other) {
              await acct.creditDeposit(tx, { userId: o.other, asset: 'ETH', amount: o.amt, eventId: `x${i}` });
              await acct.hold(tx, { userId: o.other, asset: 'ETH', amount: o.amt, orderId: `s${i}` });
              await acct.settleTrade(tx, { id: `t${i}`, base: 'ETH', quote: 'USDT', qty: o.amt, quoteQty: o.amt, buyerUserId: o.user, sellerUserId: o.other, buyerFee: o.amt / 100n, sellerFee: o.amt / 50n });
            }
          })
          .catch((e) => {
            if (!(e instanceof InsufficientFundsError)) throw e;
          });
      }
    }
    const rep = await ledger.checkInvariants();
    expect(rep).toEqual({ ok: true, problems: [] });
    const custody = await ledger.totalsByOwnerType('custody');
    const users = await ledger.totalsByOwnerType('user');
    const fees = await ledger.totalsByOwnerType('fees');
    for (const asset of Object.keys(custody)) {
      expect(custody[asset]).toBe((users[asset] ?? 0n) + (fees[asset] ?? 0n));
    }
  }, 60_000);
});
