/**
 * EN: Typed client for the AlphaNex API. The session token lives in sessionStorage (cleared when
 *     the tab closes); it is never put in a URL. Every money-moving POST sends an Idempotency-Key.
 * ES: Cliente tipado de la API AlphaNex. El token de sesión vive en sessionStorage (se borra al
 *     cerrar la pestaña); nunca va en una URL. Cada POST que mueve dinero manda Idempotency-Key.
 */
// EN: Defaults to the local API on loopback; NEXT_PUBLIC_API_URL is inlined at build time (not a secret).
// ES: Por defecto la API local en loopback; NEXT_PUBLIC_API_URL se incrusta al compilar (no es un secreto).
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:4000';
// EN: Same host, ws:// or wss:// depending on the API scheme.
// ES: Mismo host, ws:// o wss:// según el esquema de la API.
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws';

const TOKEN_KEY = 'anx_token';

// EN: SSR-safe: there is no window (and no token) while rendering on the server.
// ES: Seguro para SSR: al renderizar en el servidor no hay window (ni token).
export function getToken(): string | null {
  return typeof window === 'undefined' ? null : window.sessionStorage.getItem(TOKEN_KEY);
}
// EN: null clears the token (logout or expired session).
// ES: null borra el token (logout o sesión expirada).
export function setToken(t: string | null): void {
  if (t) window.sessionStorage.setItem(TOKEN_KEY, t);
  else window.sessionStorage.removeItem(TOKEN_KEY);
}

/** EN: Error carrying the API error code. / ES: Error con el código de error de la API. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** EN: Random key for idempotent POSTs. / ES: Clave aleatoria para POSTs idempotentes. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

// EN: Single fetch wrapper: adds Bearer auth, JSON body, optional Idempotency-Key, and maps errors to ApiError.
// ES: Único wrapper de fetch: agrega auth Bearer, cuerpo JSON, Idempotency-Key opcional y mapea errores a ApiError.
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  // EN: A double click creates two keys, so the UI also disables buttons while a request is in flight.
  // ES: Un doble clic crea dos claves, por eso la UI además deshabilita los botones mientras hay un pedido en curso.
  if (opts.idempotent) headers['idempotency-key'] = newIdempotencyKey();
  const res = await fetch(API_URL + path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store' });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // EN: Expired session → forget the token. / ES: Sesión expirada → olvidar el token.
    if (res.status === 401 && token) setToken(null);
    throw new ApiError(res.status, json.error ?? 'error', json.message ?? res.statusText);
  }
  return json as T;
}

// EN: Shapes returned by the API (subset used by the UI). / ES: Formas que devuelve la API (subconjunto usado por la UI).
// EN: Amounts are ALWAYS decimal strings: never parse money into JS floats.
// ES: Los montos son SIEMPRE strings decimales: nunca convertir dinero a floats de JS.
export interface Market {
  id: string;
  base: string;
  quote: string;
  tickSize: string;
  lotSize: string;
  minQty: string;
  makerFeeBps: number;
  takerFeeBps: number;
  frozen: boolean;
}
export interface Level {
  price: string;
  qty: string;
}
export interface Book {
  market: string;
  bids: Level[];
  asks: Level[];
}
export interface Trade {
  id: string;
  price: string;
  qty: string;
  side: 'buy' | 'sell';
  at: string;
}
export interface Order {
  id: string;
  market: string;
  side: 'buy' | 'sell';
  type: string;
  tif: string;
  price: string | null;
  qty: string;
  remaining: string;
  filled: string;
  status: string;
  createdAt: string;
}
export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  frozen: boolean;
  walletAddress: string | null;
}
// EN: Per asset: available (free), locked (open orders), withdrawing (pending payouts).
// ES: Por activo: available (libre), locked (órdenes abiertas), withdrawing (pagos pendientes).
export type Balances = Record<string, { available: string; locked: string; withdrawing: string }>;
export interface Candle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
