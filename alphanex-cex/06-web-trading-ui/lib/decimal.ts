/**
 * EN: Exact decimal helpers for the UI using bigint (never floats for money).
 *     The server is the source of truth; these only help with input validation and display.
 * ES: Helpers decimales exactos para la UI con bigint (nunca floats para dinero).
 *     El servidor es la fuente de verdad; esto solo ayuda a validar entradas y mostrar.
 */

/** EN: Valid unsigned decimal string. / ES: String decimal sin signo válido. */
export const DECIMAL_RE = /^(0|[1-9]\d{0,39})(\.\d{1,36})?$/;

/** EN: "1.5" with 6 decimals → 1500000n. Throws on too many decimals. / ES: "1.5" con 6 decimales → 1500000n. Lanza si hay demasiados decimales. */
export function toUnits(s: string, decimals: number): bigint {
  const v = s.trim();
  if (!DECIMAL_RE.test(v)) throw new Error('invalid number');
  // EN: Split whole/fraction and right-pad the fraction: "1.5" @6 → "1" + "500000".
  // ES: Separar entero/fracción y rellenar la fracción: "1.5" @6 → "1" + "500000".
  const [w, f = ''] = v.split('.');
  if (f.length > decimals) throw new Error(`max ${decimals} decimals`);
  return BigInt(w! + f.padEnd(decimals, '0'));
}

/** EN: Inverse of toUnits, trims trailing zeros. / ES: Inversa de toUnits, recorta ceros finales. */
export function fromUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  let out = (a / base).toString();
  // EN: Left-pad the fraction to `decimals` digits, then strip trailing zeros.
  // ES: Rellenar la fracción a `decimals` dígitos y quitar ceros finales.
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac) out += '.' + frac;
  return neg ? '-' + out : out;
}

/** EN: True when `value` is a multiple of `step` (both decimal strings). / ES: True si `value` es múltiplo de `step` (ambos strings decimales). */
export function isMultipleOf(value: string, step: string): boolean {
  const d = Math.max(decimalsOf(value), decimalsOf(step));
  // EN: Scale both to the same number of decimals, then use integer modulo.
  // ES: Escalar ambos a la misma cantidad de decimales y usar módulo entero.
  const s = toUnits(step, d);
  return s > 0n && toUnits(value, d) % s === 0n;
}

/** EN: Number of fractional digits. / ES: Cantidad de dígitos fraccionarios. */
export function decimalsOf(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** EN: price × qty, exact, as a decimal string. / ES: precio × cantidad, exacto, como string decimal. */
export function mulDec(a: string, b: string): string {
  const da = decimalsOf(a);
  const db = decimalsOf(b);
  // EN: Integer product; decimals add up (e.g. 2 + 1 = 3).
  // ES: Producto entero; los decimales se suman (p. ej. 2 + 1 = 3).
  return fromUnits(toUnits(a, da) * toUnits(b, db), da + db);
}

/** EN: Compare two decimal strings (-1, 0, 1). / ES: Compara dos strings decimales (-1, 0, 1). */
export function cmpDec(a: string, b: string): number {
  const d = Math.max(decimalsOf(a), decimalsOf(b));
  const x = toUnits(a, d);
  const y = toUnits(b, d);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** EN: Spread (ask − bid) and its bps of mid, or null. / ES: Spread (ask − bid) y sus bps del medio, o null. */
export function spread(bid: string | null | undefined, ask: string | null | undefined): { abs: string; bps: string } | null {
  if (!bid || !ask) return null;
  const d = Math.max(decimalsOf(bid), decimalsOf(ask), 2);
  const b = toUnits(bid, d);
  const a = toUnits(ask, d);
  // EN: Mid price; bps are reported with 2 decimals (×100 extra precision).
  // ES: Precio medio; los bps se informan con 2 decimales (×100 de precisión extra).
  const mid = (a + b) / 2n;
  if (mid === 0n) return null;
  // EN: Two decimals of bps. / ES: Dos decimales de bps.
  const bps = ((a - b) * 1_000_000n) / mid;
  return { abs: fromUnits(a - b, d), bps: fromUnits(bps, 2) };
}

/**
 * EN: Client-side order checks mirroring the server (tick, lot, min qty, funds). Returns an error
 *     message or null. The server re-validates everything.
 * ES: Chequeos de orden en cliente que reflejan al servidor (tick, lote, cantidad mínima, fondos).
 *     Devuelve un mensaje de error o null. El servidor re-valida todo.
 */
export function validateOrder(
  o: { side: 'buy' | 'sell'; type: 'limit' | 'market'; price?: string; qty: string },
  m: { tickSize: string; lotSize: string; minQty: string },
  available: { base: string; quote: string },
): string | null {
  // EN: Checks run in order and return the first problem, bilingual for the user.
  // ES: Los chequeos corren en orden y devuelven el primer problema, bilingüe para el usuario.
  if (!DECIMAL_RE.test(o.qty)) return 'Invalid quantity / Cantidad inválida';
  if (!isMultipleOf(o.qty, m.lotSize)) return `Quantity step ${m.lotSize} / Paso de cantidad ${m.lotSize}`;
  if (cmpDec(o.qty, m.minQty) < 0) return `Min quantity ${m.minQty} / Cantidad mínima ${m.minQty}`;
  if (o.type === 'limit') {
    if (!o.price || !DECIMAL_RE.test(o.price) || cmpDec(o.price, '0') <= 0) return 'Invalid price / Precio inválido';
    if (!isMultipleOf(o.price, m.tickSize)) return `Price tick ${m.tickSize} / Tick de precio ${m.tickSize}`;
    if (o.side === 'buy' && cmpDec(mulDec(o.price, o.qty), available.quote) > 0) return 'Insufficient quote balance / Saldo insuficiente';
  }
  // EN: Market buys skip the funds check: their cost is unknown until matched (the server caps it).
  // ES: Las compras a mercado omiten el chequeo de fondos: el costo se conoce al casar (el servidor lo limita).
  if (o.side === 'sell' && cmpDec(o.qty, available.base) > 0) return 'Insufficient base balance / Saldo insuficiente';
  return null;
}
