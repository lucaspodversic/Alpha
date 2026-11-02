/**
 * EN: Fixed-point helpers. Every amount in AlphaNex is an integer `bigint` expressed in the
 *     asset's smallest unit (wei for ETH, 1e-6 for USDT). Floats are NEVER used for money.
 * ES: Utilidades de punto fijo. Todo monto en AlphaNex es un `bigint` entero expresado en la
 *     unidad mínima del activo (wei para ETH, 1e-6 para USDT). Nunca se usan floats para dinero.
 */

/**
 * EN: Thrown when a human decimal string cannot be represented exactly.
 * ES: Se lanza cuando un string decimal humano no puede representarse exactamente.
 */
export class PrecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrecisionError';
  }
}

// EN: Accepts "123", "123.45", "0.001" — no signs, no exponents, no spaces.
// ES: Acepta "123", "123.45", "0.001" — sin signos, sin exponentes, sin espacios.
const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * EN: Converts a human decimal string ("1.5") into base units (1500000 for 6 decimals).
 *     Rejects inputs with more decimals than the asset supports instead of rounding silently.
 * ES: Convierte un string decimal humano ("1.5") a unidades base (1500000 con 6 decimales).
 *     Rechaza entradas con más decimales de los que soporta el activo en vez de redondear en silencio.
 */
export function parseUnits(value: string, decimals: number): bigint {
  // EN: Normalise whitespace only; everything else must match the strict regex.
  // ES: Solo normalizamos espacios; el resto debe cumplir la regex estricta.
  const trimmed = String(value).trim();
  const m = DECIMAL_RE.exec(trimmed);
  if (!m) throw new PrecisionError(`invalid decimal: "${value}"`);
  const whole = m[1]!;
  const frac = m[2] ?? '';
  // EN: Extra trailing zeros are harmless ("1.500000000" for 6 decimals); real digits are not.
  // ES: Ceros extra al final no molestan ("1.500000000" con 6 decimales); dígitos reales sí.
  const significantFrac = frac.replace(/0+$/, '');
  if (significantFrac.length > decimals) {
    throw new PrecisionError(`too many decimals for ${decimals}: "${value}"`);
  }
  const padded = (significantFrac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + (decimals > 0 ? BigInt(padded || '0') : 0n);
}

/**
 * EN: Converts base units back into a canonical human string without trailing zeros.
 * ES: Convierte unidades base a un string humano canónico sin ceros finales.
 */
export function formatUnits(value: bigint, decimals: number): string {
  // EN: Handle negatives for completeness (ledger diffs can be negative in reports).
  // ES: Manejamos negativos por completitud (las diferencias de conciliación pueden ser negativas).
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let out = whole.toString();
  if (decimals > 0 && frac > 0n) {
    out += '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  }
  return negative ? '-' + out : out;
}

/**
 * EN: Integer ceiling division for non-negative operands. Used for fees so rounding favours
 *     the venue by at most 1 base unit and funds are always conserved exactly.
 * ES: División entera hacia arriba para operandos no negativos. Se usa en comisiones para que el
 *     redondeo favorezca al exchange como máximo en 1 unidad base y los fondos se conserven exactos.
 */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor must be > 0');
  if (a < 0n) throw new RangeError('ceilDiv: dividend must be >= 0');
  return (a + b - 1n) / b;
}

/**
 * EN: Fee for `amount` at `bps` basis points (1 bps = 0.01%), rounded up.
 * ES: Comisión sobre `amount` a `bps` puntos básicos (1 bps = 0,01%), redondeada hacia arriba.
 */
export function feeFor(amount: bigint, bps: bigint): bigint {
  if (bps === 0n || amount === 0n) return 0n;
  return ceilDiv(amount * bps, 10_000n);
}

/**
 * EN: Minimum / maximum helpers for bigint (Math.min does not accept bigint).
 * ES: Mínimo / máximo para bigint (Math.min no acepta bigint).
 */
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
