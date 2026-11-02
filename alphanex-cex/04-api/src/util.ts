/**
 * EN: Small shared helpers. / ES: Pequeños helpers compartidos.
 */
import { createHash, randomBytes } from 'node:crypto';

/** EN: Deep-converts bigint to decimal strings for JSON. / ES: Convierte bigint a strings decimales en profundidad para JSON. */
export function jsonSafe<T>(v: T): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  // EN: Dates are left to JSON.stringify (ISO strings).
  // ES: Las fechas se dejan a JSON.stringify (strings ISO).
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonSafe(x);
    return out;
  }
  return v;
}

/** EN: sha256 hex. / ES: sha256 en hex. */
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** EN: URL-safe random token. / ES: Token aleatorio seguro para URL. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** EN: Promise-chain mutex (single writer). / ES: Mutex por cadena de promesas (un solo escritor). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    // EN: Run after the previous task whether it succeeded or failed; the chain never breaks.
    // ES: Correr después de la tarea anterior, haya salido bien o mal; la cadena nunca se rompe.
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

/** EN: NUMERIC text → bigint (null-safe). / ES: Texto NUMERIC → bigint (seguro ante null). */
export const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(String(v)));
