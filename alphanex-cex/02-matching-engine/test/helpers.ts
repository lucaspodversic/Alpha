/**
 * EN: Test helpers: a small market with simple numbers so expectations are easy to read.
 * ES: Utilidades de test: un mercado chico con números simples para que las expectativas se lean fácil.
 */
import { OrderBook, type MarketSpec, type NewOrder } from '../src/index.js';

// EN: baseDecimals = 2 → 1 "whole" base = 100 units; tick 1 and lot 100 keep math trivial.
// ES: baseDecimals = 2 → 1 base "entero" = 100 unidades; tick 1 y lote 100 dejan la matemática trivial.
export const SPEC: MarketSpec = {
  id: 'T-Q',
  base: 'T',
  quote: 'Q',
  baseDecimals: 2,
  quoteDecimals: 2,
  tickSize: 1n,
  lotSize: 100n,
  minQty: 100n,
  makerFeeBps: 10n,
  takerFeeBps: 20n,
};

/** EN: Fresh book. / ES: Libro nuevo. */
export const book = (spec: MarketSpec = SPEC) => new OrderBook(spec);

let n = 0;
/**
 * EN: Builds a limit order; qty given in whole base units for readability.
 * ES: Arma una orden límite; la cantidad se da en unidades base enteras para que se lea mejor.
 */
export function limit(userId: string, side: 'buy' | 'sell', price: bigint, wholeQty: bigint, extra: Partial<NewOrder> = {}): NewOrder {
  return { id: `o${++n}`, userId, side, type: 'limit', price, qty: wholeQty * 100n, ...extra };
}

/** EN: Builds a market order. / ES: Arma una orden de mercado. */
export function market(userId: string, side: 'buy' | 'sell', wholeQty: bigint, extra: Partial<NewOrder> = {}): NewOrder {
  return { id: `m${++n}`, userId, side, type: 'market', qty: wholeQty * 100n, ...extra };
}
