/**
 * EN: Append-only audit log with hash chaining. Each row stores
 *       hash = sha256(prev_hash | seq | at | actor | action | target | details)
 *     so editing or deleting any past row breaks every later hash (detected by `verify`).
 *     The DB trigger additionally forbids UPDATE/DELETE. Writes are serialized with a
 *     transaction-scoped advisory lock so two concurrent appends can't fork the chain.
 * ES: Log de auditoría append-only con encadenamiento de hashes. Cada fila guarda
 *       hash = sha256(prev_hash | seq | at | actor | action | target | details)
 *     así editar o borrar cualquier fila pasada rompe todos los hashes siguientes (lo detecta
 *     `verify`). El trigger de la BD además prohíbe UPDATE/DELETE. Las escrituras se serializan
 *     con un advisory lock de transacción para que dos appends concurrentes no bifurquen la cadena.
 */
import type { Db, Queryable } from '@alphanex/ledger';
import { canonicalJson } from '@alphanex/custody';
import { jsonSafe, sha256 } from '../util.js';

// EN: Genesis "previous hash". / ES: "Hash previo" génesis.
export const GENESIS_HASH = '0'.repeat(64);
// EN: Arbitrary advisory-lock key for the audit chain. / ES: Clave arbitraria de advisory lock para la cadena.
const AUDIT_LOCK = 7331;

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditRow {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  details: string;
  prev_hash: string;
  hash: string;
}

/** EN: Hash function shared by append and verify. / ES: Función de hash compartida por append y verify. */
export function auditHash(prev: string, seq: number, at: string, actor: string, action: string, target: string | null, details: string): string {
  return sha256([prev, seq, at, actor, action, target ?? '', details].join('|'));
}

export class AuditLog {
  constructor(private readonly db: Db) {}

  /**
   * EN: Appends inside the caller's transaction (so the audit row commits/rolls back with the action).
   * ES: Agrega dentro de la transacción del llamador (la fila de auditoría se confirma/revierte con la acción).
   */
  async append(tx: Queryable, e: AuditEntry): Promise<AuditRow> {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
    const last = await tx.query<{ seq: string; hash: string }>('SELECT seq::text AS seq, hash FROM audit_log ORDER BY audit_log.seq DESC LIMIT 1');
    const prev = last.rows[0]?.hash ?? GENESIS_HASH;
    const seq = last.rows[0] ? Number(last.rows[0].seq) + 1 : 1;
    const at = new Date().toISOString();
    const details = canonicalJson(jsonSafe(e.details ?? {}));
    const target = e.target ?? null;
    const hash = auditHash(prev, seq, at, e.actor, e.action, target, details);
    await tx.query(`INSERT INTO audit_log(seq, at, actor, action, target, details, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      seq,
      at,
      e.actor,
      e.action,
      target,
      details,
      prev,
      hash,
    ]);
    return { seq, at, actor: e.actor, action: e.action, target, details, prev_hash: prev, hash };
  }

  /** EN: Standalone append in its own transaction. / ES: Append independiente en su propia transacción. */
  record(e: AuditEntry): Promise<AuditRow> {
    return this.db.transaction((tx) => this.append(tx, e));
  }

  /** EN: Newest rows first. / ES: Filas más nuevas primero. */
  async list(limit = 100, action?: string): Promise<AuditRow[]> {
    const r = await this.db.query<AuditRow & { seq: string }>(
      `SELECT seq::text AS seq, at, actor, action, target, details, prev_hash, hash FROM audit_log
       WHERE ($2::text IS NULL OR action = $2) ORDER BY audit_log.seq DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 1000), action ?? null],
    );
    return r.rows.map((x) => ({ ...x, seq: Number(x.seq) }));
  }

  /**
   * EN: Recomputes the whole chain. Returns the first broken seq, if any.
   * ES: Recalcula toda la cadena. Devuelve el primer seq roto, si hay.
   */
  async verify(): Promise<{ ok: boolean; count: number; brokenAt?: number; head?: string }> {
    const r = await this.db.query<AuditRow & { seq: string }>(
      'SELECT seq::text AS seq, at, actor, action, target, details, prev_hash, hash FROM audit_log ORDER BY audit_log.seq ASC',
    );
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const row of r.rows) {
      const seq = Number(row.seq);
      const h = auditHash(prev, seq, row.at, row.actor, row.action, row.target, row.details);
      if (seq !== expectedSeq || row.prev_hash !== prev || row.hash !== h) return { ok: false, count: r.rows.length, brokenAt: seq };
      prev = row.hash;
      expectedSeq++;
    }
    return { ok: true, count: r.rows.length, head: prev };
  }
}
