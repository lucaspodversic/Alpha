// EN: UI helper tests (exact decimal math, order validation, chart geometry). / ES: Tests de helpers de UI (decimales exactos, validación de órdenes, geometría del gráfico).
import { describe, it, expect } from 'vitest';
import { cmpDec, fromUnits, isMultipleOf, mulDec, spread, toUnits, validateOrder } from '../lib/decimal';
import { candleGeometry } from '../lib/chart';

// EN: Market fixture shaped like ETH/USDT (tick 0.01, lot 0.0001).
// ES: Fixture de mercado con la forma de ETH/USDT (tick 0.01, lote 0.0001).
const M = { tickSize: '0.01', lotSize: '0.0001', minQty: '0.0001' };

describe('decimal helpers', () => {
  it('round-trips units without float error / ida y vuelta de unidades sin error de float', () => {
    // EN: 0.1 is not representable in binary floats, but is exact as bigint units.
    // ES: 0.1 no es representable en floats binarios, pero es exacto como unidades bigint.
    expect(toUnits('0.1', 18)).toBe(100000000000000000n);
    expect(fromUnits(toUnits('1234.5678', 6), 6)).toBe('1234.5678');
    expect(fromUnits(-1500000n, 6)).toBe('-1.5');
    // EN: Too many decimals, scientific notation and negatives are all rejected.
    // ES: Demasiados decimales, notación científica y negativos se rechazan.
    expect(() => toUnits('1.1234567', 6)).toThrow();
    expect(() => toUnits('1e5', 6)).toThrow();
    expect(() => toUnits('-1', 6)).toThrow();
  });
  it('multiplies and compares exactly / multiplica y compara exacto', () => {
    // EN: In JS floats 0.1*0.2 = 0.020000000000000004; here it is exact.
    // ES: En floats de JS 0.1*0.2 = 0.020000000000000004; aquí es exacto.
    expect(mulDec('0.1', '0.2')).toBe('0.02');
    expect(mulDec('2000.5', '0.4')).toBe('800.2');
    expect(cmpDec('1.10', '1.1')).toBe(0);
    expect(cmpDec('0.0000001', '0')).toBe(1);
  });
  it('tick / lot multiples / múltiplos de tick / lote', () => {
    expect(isMultipleOf('2000.01', '0.01')).toBe(true);
    expect(isMultipleOf('2000.015', '0.01')).toBe(false);
    // EN: A zero step is invalid config, never "everything matches".
    // ES: Un paso cero es config inválida, nunca "todo coincide".
    expect(isMultipleOf('5', '0')).toBe(false);
  });
  it('spread in bps / spread en bps', () => {
    // EN: (101-99) / mid 100 = 2% = 200 bps; a missing side gives null.
    // ES: (101-99) / medio 100 = 2% = 200 bps; si falta un lado da null.
    expect(spread('99', '101')).toEqual({ abs: '2', bps: '200' });
    expect(spread(null, '1')).toBeNull();
  });
});

describe('validateOrder', () => {
  // EN: Available balances: 1 ETH and 1000 USDT.
  // ES: Saldos disponibles: 1 ETH y 1000 USDT.
  const avail = { base: '1', quote: '1000' };
  it('accepts a valid limit buy / acepta una compra límite válida', () => {
    expect(validateOrder({ side: 'buy', type: 'limit', price: '2000', qty: '0.5' }, M, avail)).toBeNull();
  });
  it('rejects bad tick, lot, min and funds / rechaza tick, lote, mínimo y fondos inválidos', () => {
    // EN: One assertion per rule: tick, lot step, funds (buy and sell), price > 0, numeric qty.
    // ES: Una aserción por regla: tick, paso de lote, fondos (compra y venta), precio > 0, cantidad numérica.
    expect(validateOrder({ side: 'buy', type: 'limit', price: '2000.001', qty: '0.1' }, M, avail)).toMatch(/tick/i);
    expect(validateOrder({ side: 'buy', type: 'limit', price: '2000', qty: '0.00015' }, M, avail)).toMatch(/step/i);
    expect(validateOrder({ side: 'buy', type: 'limit', price: '2000', qty: '0.6' }, M, avail)).toMatch(/insufficient/i);
    expect(validateOrder({ side: 'sell', type: 'market', qty: '2' }, M, avail)).toMatch(/insufficient/i);
    expect(validateOrder({ side: 'buy', type: 'limit', price: '0', qty: '0.1' }, M, avail)).toMatch(/price/i);
    expect(validateOrder({ side: 'buy', type: 'market', qty: 'abc' }, M, avail)).toMatch(/quantity/i);
  });
});

describe('candleGeometry', () => {
  it('maps high above low and colours by direction / ubica el máximo sobre el mínimo y colorea por dirección', () => {
    const g = candleGeometry(
      [
        { time: 1, open: '10', high: '12', low: '9', close: '11', volume: '1' },
        { time: 2, open: '11', high: '11', low: '8', close: '8', volume: '1' },
      ],
      200,
      100,
    );
    // EN: SVG y grows downwards, so the high must have a smaller y than the low.
    // ES: En SVG la y crece hacia abajo, así que el máximo debe tener menor y que el mínimo.
    expect(g).toHaveLength(2);
    expect(g[0]!.yHigh).toBeLessThan(g[0]!.yLow);
    expect(g[0]!.up).toBe(true);
    expect(g[1]!.up).toBe(false);
    // EN: No candles → nothing to draw (no division by zero).
    // ES: Sin velas → nada que dibujar (sin división por cero).
    expect(candleGeometry([], 10, 10)).toEqual([]);
  });
});
