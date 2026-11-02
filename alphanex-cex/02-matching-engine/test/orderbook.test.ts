/**
 * EN: Unit tests for the order book: priority, partial fills, order types, STP, fees, recovery.
 * ES: Tests unitarios del libro: prioridad, ejecuciones parciales, tipos de orden, STP, comisiones, recuperación.
 */
import { describe, expect, it } from 'vitest';
import { OrderBook, OrderValidationError, SEED_MARKETS, validateMarketSpec } from '../src/index.js';
import { book, limit, market, SPEC } from './helpers.js';

describe('validation / validación', () => {
  it('EN: seed markets are valid / ES: los mercados semilla son válidos', () => {
    for (const m of SEED_MARKETS) expect(() => validateMarketSpec(m)).not.toThrow();
  });

  it('EN: rejects spec where quote math would be inexact / ES: rechaza spec con matemática quote inexacta', () => {
    expect(() => new OrderBook({ ...SPEC, lotSize: 10n, minQty: 10n })).toThrow(OrderValidationError);
  });

  it('EN: rejects bad orders / ES: rechaza órdenes inválidas', () => {
    const b = book();
    expect(() => b.submit({ id: 'x', userId: 'u', side: 'buy', type: 'limit', price: 10n, qty: 150n })).toThrow(/lotSize/);
    expect(() => b.submit({ id: 'x', userId: 'u', side: 'buy', type: 'limit', qty: 100n })).toThrow(/price/);
    expect(() => b.submit({ id: 'x', userId: 'u', side: 'buy', type: 'limit', price: 0n, qty: 100n })).toThrow();
    expect(() => b.submit({ id: 'x', userId: 'u', side: 'buy', type: 'market', price: 5n, qty: 100n })).toThrow(/market/);
    expect(() => b.submit({ id: 'x', userId: 'u', side: 'buy', type: 'limit', price: 5n, qty: 0n })).toThrow(/minQty/);
  });

  it('EN: rejects duplicate ids of resting orders / ES: rechaza ids duplicados de órdenes en libro', () => {
    const b = book();
    b.submit({ id: 'dup', userId: 'u', side: 'buy', type: 'limit', price: 5n, qty: 100n });
    expect(() => b.submit({ id: 'dup', userId: 'u', side: 'buy', type: 'limit', price: 5n, qty: 100n })).toThrow(/duplicate/);
  });
});

describe('matching / cruce', () => {
  it('EN: rests non-crossing orders and reports best prices / ES: deja órdenes que no cruzan y reporta mejores precios', () => {
    const b = book();
    expect(b.submit(limit('a', 'buy', 99n, 1n)).status).toBe('open');
    expect(b.submit(limit('b', 'sell', 101n, 1n)).status).toBe('open');
    expect(b.bestBid()).toBe(99n);
    expect(b.bestAsk()).toBe(101n);
    expect(b.size()).toBe(2);
  });

  it('EN: executes at maker price (price improvement for taker) / ES: ejecuta al precio del maker (mejora para el taker)', () => {
    const b = book();
    b.submit(limit('maker', 'sell', 100n, 1n));
    const r = b.submit(limit('taker', 'buy', 105n, 1n));
    expect(r.status).toBe('filled');
    expect(r.trades[0]!.price).toBe(100n);
    expect(r.trades[0]!.quoteQty).toBe(100n);
    expect(r.filledQuote).toBe(100n);
  });

  it('EN: price priority then time priority / ES: prioridad por precio y luego por tiempo', () => {
    const b = book();
    const first = limit('a', 'sell', 101n, 1n);
    const second = limit('b', 'sell', 101n, 1n);
    const better = limit('c', 'sell', 100n, 1n);
    b.submit(first);
    b.submit(second);
    b.submit(better);
    const r = b.submit(limit('t', 'buy', 101n, 3n));
    expect(r.trades.map((t) => t.makerOrderId)).toEqual([better.id, first.id, second.id]);
  });

  it('EN: partial fill leaves maker remainder / ES: ejecución parcial deja remanente del maker', () => {
    const b = book();
    const m = limit('a', 'sell', 100n, 5n);
    b.submit(m);
    const r = b.submit(limit('t', 'buy', 100n, 2n));
    expect(r.status).toBe('filled');
    expect(r.makerUpdates[0]).toMatchObject({ orderId: m.id, status: 'partially_filled', remaining: 300n });
    expect(b.depth().asks[0]).toEqual({ price: 100n, qty: 300n, orders: 1 });
  });

  it('EN: taker remainder rests as GTC / ES: el remanente del taker queda como GTC', () => {
    const b = book();
    b.submit(limit('a', 'sell', 100n, 1n));
    const r = b.submit(limit('t', 'buy', 100n, 3n));
    expect(r.status).toBe('partially_filled');
    expect(r.resting).toBe(200n);
    expect(b.bestBid()).toBe(100n);
    expect(b.bestAsk()).toBeNull();
  });

  it('EN: IOC never rests / ES: IOC nunca queda en el libro', () => {
    const b = book();
    b.submit(limit('a', 'sell', 100n, 1n));
    const r = b.submit(limit('t', 'buy', 100n, 3n, { tif: 'IOC' }));
    expect(r.status).toBe('canceled');
    expect(r.filled).toBe(100n);
    expect(r.reason).toBe('ioc_remainder_canceled');
    expect(b.size()).toBe(0);
  });

  it('EN: POST_ONLY rejected when crossing, rests otherwise / ES: POST_ONLY rechazada si cruza, si no queda', () => {
    const b = book();
    b.submit(limit('a', 'sell', 100n, 1n));
    expect(b.submit(limit('t', 'buy', 100n, 1n, { tif: 'POST_ONLY' })).status).toBe('rejected');
    expect(b.submit(limit('t', 'buy', 99n, 1n, { tif: 'POST_ONLY' })).status).toBe('open');
  });

  it('EN: market order sweeps levels and cancels remainder / ES: orden de mercado barre niveles y cancela el resto', () => {
    const b = book();
    b.submit(limit('a', 'sell', 100n, 1n));
    b.submit(limit('b', 'sell', 110n, 1n));
    const r = b.submit(market('t', 'buy', 3n));
    expect(r.trades.map((t) => t.price)).toEqual([100n, 110n]);
    expect(r.filled).toBe(200n);
    expect(r.filledQuote).toBe(210n);
    expect(r.status).toBe('canceled');
  });

  it('EN: market order on empty book / ES: orden de mercado con libro vacío', () => {
    const r = book().submit(market('t', 'sell', 1n));
    expect(r.status).toBe('canceled');
    expect(r.reason).toBe('no_liquidity');
  });

  it('EN: market buy respects maxQuote budget / ES: compra a mercado respeta el presupuesto maxQuote', () => {
    const b = book();
    b.submit(limit('a', 'sell', 100n, 5n));
    const r = b.submit(market('t', 'buy', 5n, { maxQuote: 250n }));
    // EN: Only 2 whole lots are affordable (2 × 100 = 200 ≤ 250). / ES: Solo alcanzan 2 lotes (2 × 100 = 200 ≤ 250).
    expect(r.filled).toBe(200n);
    expect(r.filledQuote).toBe(200n);
    expect(r.reason).toBe('insufficient_quote_budget');
  });

  it('EN: quoteMarketBuy matches actual execution cost / ES: quoteMarketBuy coincide con el costo real', () => {
    const b = book();
    b.submit(limit('a', 'sell', 100n, 1n));
    b.submit(limit('b', 'sell', 120n, 2n));
    const q = b.quoteMarketBuy(300n);
    const r = b.submit(market('t', 'buy', 3n));
    expect(q).toEqual({ fillable: 300n, cost: r.filledQuote });
    expect(r.filledQuote).toBe(340n);
  });

  it('EN: self-trade prevention cancels taker remainder / ES: STP cancela el remanente del taker', () => {
    const b = book();
    const own = limit('u', 'sell', 100n, 1n);
    b.submit(own);
    const r = b.submit(limit('u', 'buy', 100n, 1n));
    expect(r.trades).toHaveLength(0);
    expect(r.status).toBe('canceled');
    expect(r.reason).toBe('self_trade_prevented');
    expect(b.getOrder(own.id)).toBeDefined();
  });
});

describe('fees / comisiones', () => {
  it('EN: taker buyer pays taker fee in base, maker seller pays maker fee in quote / ES: comprador taker paga fee taker en base y vendedor maker paga fee maker en quote', () => {
    const b = book();
    b.submit(limit('m', 'sell', 10_000n, 100n));
    const t = b.submit(limit('t', 'buy', 10_000n, 100n)).trades[0]!;
    // EN: qty 10000 units × 20 bps = 20; quote 1,000,000 × 10 bps = 1000.
    // ES: cantidad 10000 unidades × 20 bps = 20; quote 1.000.000 × 10 bps = 1000.
    expect(t.buyerFee).toBe(20n);
    expect(t.sellerFee).toBe(1000n);
  });

  it('EN: taker seller pays taker fee in quote / ES: vendedor taker paga fee taker en quote', () => {
    const b = book();
    b.submit(limit('m', 'buy', 10_000n, 100n));
    const t = b.submit(limit('t', 'sell', 10_000n, 100n)).trades[0]!;
    expect(t.buyerFee).toBe(10n);
    expect(t.sellerFee).toBe(2000n);
  });
});

describe('cancel & recovery / cancelación y recuperación', () => {
  it('EN: cancel removes order and empty level / ES: cancelar quita la orden y el nivel vacío', () => {
    const b = book();
    const o = limit('a', 'buy', 99n, 2n);
    b.submit(o);
    expect(b.cancel(o.id)?.remaining).toBe(200n);
    expect(b.cancel(o.id)).toBeNull();
    expect(b.bestBid()).toBeNull();
  });

  it('EN: cancelAllForUser only touches that user / ES: cancelAllForUser solo toca a ese usuario', () => {
    const b = book();
    b.submit(limit('a', 'buy', 99n, 1n));
    b.submit(limit('a', 'sell', 120n, 1n));
    b.submit(limit('b', 'buy', 98n, 1n));
    expect(b.cancelAllForUser('a')).toHaveLength(2);
    expect(b.size()).toBe(1);
  });

  it('EN: snapshot/restore preserves priority and sequences / ES: snapshot/restore preserva prioridad y secuencias', () => {
    const b = book();
    const x = limit('a', 'sell', 100n, 1n);
    const y = limit('b', 'sell', 100n, 1n);
    b.submit(x);
    b.submit(y);
    const restored = OrderBook.restore(SPEC, b.snapshot());
    const r = restored.submit(limit('t', 'buy', 100n, 1n));
    expect(r.trades[0]!.makerOrderId).toBe(x.id);
    expect(restored.depth()).toEqual({ bids: [], asks: [{ price: 100n, qty: 100n, orders: 1 }] });
  });

  it('EN: depth aggregates and limits levels / ES: depth agrega y limita niveles', () => {
    const b = book();
    for (let p = 90n; p < 100n; p++) b.submit(limit('a', 'buy', p, 1n));
    b.submit(limit('c', 'buy', 99n, 2n));
    const d = b.depth(3);
    expect(d.bids.map((l) => l.price)).toEqual([99n, 98n, 97n]);
    expect(d.bids[0]).toEqual({ price: 99n, qty: 300n, orders: 2 });
  });
});
