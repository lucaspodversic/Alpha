/**
 * EN: Tests for fixed-point parsing/formatting and fee rounding.
 * ES: Tests de parseo/formateo de punto fijo y redondeo de comisiones.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ceilDiv, feeFor, formatUnits, parseUnits, PrecisionError } from '../src/index.js';

describe('parseUnits / formatUnits', () => {
  it('EN: parses decimals exactly / ES: parsea decimales exactos', () => {
    expect(parseUnits('1.5', 6)).toBe(1_500_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('42', 0)).toBe(42n);
    expect(parseUnits('1.500000000', 6)).toBe(1_500_000n);
  });

  it('EN: rejects excess precision and junk / ES: rechaza precisión de más y basura', () => {
    expect(() => parseUnits('0.0000001', 6)).toThrow(PrecisionError);
    expect(() => parseUnits('-1', 6)).toThrow(PrecisionError);
    expect(() => parseUnits('1e5', 6)).toThrow(PrecisionError);
    expect(() => parseUnits('', 6)).toThrow(PrecisionError);
    expect(() => parseUnits('1.2.3', 6)).toThrow(PrecisionError);
  });

  it('EN: formats canonical strings / ES: formatea strings canónicos', () => {
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001');
    expect(formatUnits(0n, 6)).toBe('0');
    expect(formatUnits(-25n, 1)).toBe('-2.5');
  });

  it('EN: round-trips for any value (property) / ES: ida y vuelta para cualquier valor (propiedad)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.integer({ min: 0, max: 18 }), (v, d) => {
        expect(parseUnits(formatUnits(v, d), d)).toBe(v);
      }),
    );
  });
});

describe('fees', () => {
  it('EN: ceilDiv rounds up / ES: ceilDiv redondea hacia arriba', () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
    expect(() => ceilDiv(1n, 0n)).toThrow();
  });

  it('EN: feeFor never exceeds amount and is >= exact fee / ES: feeFor nunca supera el monto y es >= la comisión exacta', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.bigInt({ min: 0n, max: 1000n }), (amt, bps) => {
        const fee = feeFor(amt, bps);
        expect(fee <= amt).toBe(true);
        expect(fee * 10_000n >= amt * bps).toBe(true);
        expect(fee * 10_000n - amt * bps < 10_000n).toBe(true);
      }),
    );
  });
});
