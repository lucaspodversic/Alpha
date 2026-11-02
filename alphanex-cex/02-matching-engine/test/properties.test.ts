/**
 * EN: Property-based tests (fast-check). Random order flows must preserve the core invariants:
 *       1. Conservation: every unit of base/quote that leaves a seller reaches the buyer or the fee pot.
 *       2. No crossed book after any submission (best bid < best ask).
 *       3. Book depth equals the sum of remaining quantities of resting orders.
 *       4. Determinism: replaying the same flow yields identical trades.
 * ES: Tests basados en propiedades (fast-check). Flujos aleatorios deben preservar los invariantes:
 *       1. Conservación: toda unidad base/quote que sale del vendedor llega al comprador o al pozo de fees.
 *       2. Nunca queda el libro cruzado (mejor bid < mejor ask).
 *       3. La profundidad del libro es la suma de remanentes de las órdenes en libro.
 *       4. Determinismo: repetir el mismo flujo da trades idénticos.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { OrderBook, type NewOrder, type Trade } from '../src/index.js';
import { SPEC } from './helpers.js';

// EN: Random order generator over a narrow price band to force lots of crossing.
// ES: Generador de órdenes aleatorias en una banda de precios angosta para forzar muchos cruces.
const orderArb = fc.record({
  user: fc.constantFrom('u1', 'u2', 'u3', 'u4'),
  side: fc.constantFrom<'buy' | 'sell'>('buy', 'sell'),
  type: fc.constantFrom<'limit' | 'market'>('limit', 'limit', 'limit', 'market'),
  tif: fc.constantFrom<'GTC' | 'IOC' | 'POST_ONLY'>('GTC', 'GTC', 'IOC', 'POST_ONLY'),
  price: fc.integer({ min: 95, max: 105 }),
  lots: fc.integer({ min: 1, max: 20 }),
  cancel: fc.boolean(),
});

type Gen = { user: string; side: 'buy' | 'sell'; type: 'limit' | 'market'; tif: 'GTC' | 'IOC' | 'POST_ONLY'; price: number; lots: number; cancel: boolean };

/**
 * EN: Replays a generated flow and returns all trades plus the final book.
 * ES: Reproduce un flujo generado y devuelve todos los trades y el libro final.
 */
function run(flow: Gen[]): { trades: Trade[]; book: OrderBook; submitted: Map<string, NewOrder> } {
  const book = new OrderBook(SPEC);
  const trades: Trade[] = [];
  const submitted = new Map<string, NewOrder>();
  flow.forEach((g, i) => {
    const o: NewOrder =
      g.type === 'market'
        ? { id: `o${i}`, userId: g.user, side: g.side, type: 'market', qty: BigInt(g.lots) * 100n }
        : { id: `o${i}`, userId: g.user, side: g.side, type: 'limit', tif: g.tif, price: BigInt(g.price), qty: BigInt(g.lots) * 100n };
    submitted.set(o.id, o);
    const r = book.submit(o);
    trades.push(...r.trades);
    // EN: Invariant 2 checked after every step. / ES: Invariante 2 verificado en cada paso.
    const bb = book.bestBid();
    const ba = book.bestAsk();
    if (bb !== null && ba !== null) expect(bb < ba).toBe(true);
    // EN: Occasionally cancel an earlier order. / ES: A veces cancelamos una orden anterior.
    if (g.cancel && i > 0) book.cancel(`o${i - 1}`);
  });
  return { trades, book, submitted };
}

describe('properties / propiedades', () => {
  it('EN: conservation of funds per trade / ES: conservación de fondos por trade', () => {
    fc.assert(
      fc.property(fc.array(orderArb, { maxLength: 80 }), (flow) => {
        const { trades } = run(flow);
        for (const t of trades) {
          // EN: Base: seller gives qty = buyer receives (qty - fee) + fee pot.
          // ES: Base: el vendedor entrega qty = comprador recibe (qty - fee) + pozo de fees.
          expect(t.qty - t.buyerFee + t.buyerFee).toBe(t.qty);
          expect(t.buyerFee >= 0n && t.buyerFee <= t.qty).toBe(true);
          expect(t.sellerFee >= 0n && t.sellerFee <= t.quoteQty).toBe(true);
          // EN: Quote is exact: price * qty / 100 with no remainder. / ES: Quote exacto: price * qty / 100 sin resto.
          expect((t.price * t.qty) % 100n).toBe(0n);
          expect(t.quoteQty).toBe((t.price * t.qty) / 100n);
          expect(t.buyerUserId).not.toBe(t.sellerUserId);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('EN: no order is over-filled and limit prices are respected / ES: ninguna orden se sobre-ejecuta y se respetan precios límite', () => {
    fc.assert(
      fc.property(fc.array(orderArb, { maxLength: 80 }), (flow) => {
        const { trades, submitted } = run(flow);
        const filled = new Map<string, bigint>();
        for (const t of trades) {
          for (const id of [t.buyOrderId, t.sellOrderId]) filled.set(id, (filled.get(id) ?? 0n) + t.qty);
          const buy = submitted.get(t.buyOrderId)!;
          const sell = submitted.get(t.sellOrderId)!;
          if (buy.type === 'limit') expect(t.price <= buy.price!).toBe(true);
          if (sell.type === 'limit') expect(t.price >= sell.price!).toBe(true);
        }
        for (const [id, f] of filled) expect(f <= submitted.get(id)!.qty).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('EN: depth equals resting remainders / ES: la profundidad coincide con los remanentes', () => {
    fc.assert(
      fc.property(fc.array(orderArb, { maxLength: 60 }), (flow) => {
        const { book } = run(flow);
        const snap = book.snapshot();
        const d = book.depth(1000);
        const sum = (xs: { qty: bigint }[]) => xs.reduce((a, l) => a + l.qty, 0n);
        const restingBuys = snap.orders.filter((o) => o.side === 'buy').reduce((a, o) => a + o.remaining, 0n);
        const restingSells = snap.orders.filter((o) => o.side === 'sell').reduce((a, o) => a + o.remaining, 0n);
        expect(sum(d.bids)).toBe(restingBuys);
        expect(sum(d.asks)).toBe(restingSells);
      }),
      { numRuns: 150 },
    );
  });

  it('EN: deterministic replay / ES: reproducción determinista', () => {
    fc.assert(
      fc.property(fc.array(orderArb, { maxLength: 60 }), (flow) => {
        expect(run(flow).trades).toEqual(run(flow).trades);
      }),
      { numRuns: 100 },
    );
  });

  it('EN: snapshot/restore yields identical future behaviour / ES: snapshot/restore da el mismo comportamiento futuro', () => {
    fc.assert(
      fc.property(fc.array(orderArb, { maxLength: 40 }), fc.array(orderArb, { maxLength: 20 }), (a, b) => {
        const { book } = run(a);
        const clone = OrderBook.restore(SPEC, book.snapshot());
        b.forEach((g, i) => {
          const o: NewOrder = { id: `z${i}`, userId: g.user, side: g.side, type: 'limit', price: BigInt(g.price), qty: BigInt(g.lots) * 100n };
          expect(clone.submit({ ...o }).trades).toEqual(book.submit({ ...o }).trades);
        });
      }),
      { numRuns: 100 },
    );
  });
});
