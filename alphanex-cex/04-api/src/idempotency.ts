/**
 * EN: Idempotency-Key support for money-moving POSTs (orders, withdrawals).
 *       - same key + same body  → the stored response is replayed (no second side effect);
 *       - same key + other body → 422 (client bug);
 *       - same key while the first call is running → 409.
 *     Failed calls delete their key so the client can retry with the same key.
 * ES: Soporte de Idempotency-Key para POSTs que mueven dinero (órdenes, retiros).
 *       - misma clave + mismo cuerpo → se repite la respuesta guardada (sin segundo efecto);
 *       - misma clave + otro cuerpo → 422 (bug del cliente);
 *       - misma clave mientras corre la primera llamada → 409.
 *     Las llamadas fallidas borran su clave para que el cliente reintente con la misma.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@alphanex/ledger';
import { canonicalJson } from '@alphanex/custody';
import { ApiError, badRequest } from './errors.js';
import { jsonSafe, sha256 } from './util.js';

export async function withIdempotency<T>(db: Db, userId: string, req: FastifyRequest, reply: FastifyReply, fn: () => Promise<{ status: number; body: T }>): Promise<unknown> {
  // EN: The header is optional: without it the call runs normally (the UI always sends one).
  // ES: El header es opcional: sin él la llamada corre normal (la UI siempre manda uno).
  const key = req.headers['idempotency-key'];
  if (key === undefined) {
    const r = await fn();
    return reply.code(r.status).send(r.body);
  }
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw badRequest('invalid_idempotency_key');
  // EN: Fingerprint = method + route + canonical body, so key reuse with a different body is detected.
  // ES: Huella = método + ruta + cuerpo canónico, para detectar reutilizar la clave con otro cuerpo.
  const hash = sha256(`${req.method} ${req.routeOptions.url} ${canonicalJson(jsonSafe(req.body ?? null))}`);
  // EN: Atomic claim: the PK (user_id, key) guarantees only one request wins the race.
  // ES: Reclamo atómico: la PK (user_id, key) garantiza que solo un pedido gane la carrera.
  const ins = await db.query('INSERT INTO idempotency_keys(user_id, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key', [userId, key, hash]);
  if (!ins.rows.length) {
    const ex = await db.query<{ request_hash: string; status_code: number | null; response: string | null }>(
      'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    const row = ex.rows[0]!;
    if (row.request_hash !== hash) throw new ApiError(422, 'idempotency_key_reused', 'key was used with a different request');
    // EN: No stored status yet = the first call is still running.
    // ES: Sin estado guardado aún = la primera llamada sigue corriendo.
    if (row.status_code === null) throw new ApiError(409, 'idempotency_in_progress');
    return reply.code(row.status_code).header('idempotent-replay', 'true').send(JSON.parse(row.response ?? 'null'));
  }
  try {
    const r = await fn();
    await db.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2', [userId, key, r.status, JSON.stringify(jsonSafe(r.body))]);
    return reply.code(r.status).send(r.body);
  } catch (e) {
    // EN: The failed call had no side effects (its DB transaction rolled back), so the key is released.
    // ES: La llamada fallida no tuvo efectos (su transacción se revirtió), así que se libera la clave.
    await db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
    throw e;
  }
}
