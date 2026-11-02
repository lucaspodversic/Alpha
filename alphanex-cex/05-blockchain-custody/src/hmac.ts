/**
 * EN: HMAC authentication between the API (withdrawal broadcaster) and the signer service.
 *     Canonical JSON (sorted keys) guarantees both sides hash identical bytes.
 * ES: Autenticación HMAC entre la API (difusor de retiros) y el servicio firmante.
 *     El JSON canónico (claves ordenadas) garantiza que ambos lados hasheen los mismos bytes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** EN: Deterministic JSON with sorted keys; bigint is rejected (send strings). / ES: JSON determinista con claves ordenadas; bigint se rechaza (enviar strings). */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') throw new TypeError('bigint not allowed in canonical JSON; use decimal strings');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** EN: hex HMAC-SHA256 of the canonical payload. / ES: HMAC-SHA256 en hex del payload canónico. */
export function signPayload(secret: string, payload: unknown): string {
  if (!secret || secret.length < 32) throw new Error('HMAC secret must be at least 32 chars');
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

/** EN: Constant-time verification. / ES: Verificación en tiempo constante. */
export function verifyPayload(secret: string, payload: unknown, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, payload), 'hex');
  const given = Buffer.from(/^[0-9a-f]{64}$/i.test(signature) ? signature : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
