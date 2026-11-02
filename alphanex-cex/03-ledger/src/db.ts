/**
 * EN: Minimal database abstraction so the same SQL runs on:
 *       - PGlite (real Postgres compiled to WASM, in-process) for tests and local dev, and
 *       - node-postgres (`pg`) Pool for staging/production.
 * ES: Abstracción mínima de base de datos para que el mismo SQL corra en:
 *       - PGlite (Postgres real compilado a WASM, en proceso) para tests y desarrollo local, y
 *       - un Pool de node-postgres (`pg`) para staging/producción.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/**
 * EN: Anything that can run a parameterised query (a pool or an open transaction).
 * ES: Cualquier cosa que pueda ejecutar una consulta parametrizada (un pool o una transacción abierta).
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * EN: A database handle with transactions.
 * ES: Un handle de base de datos con transacciones.
 */
export interface Db extends Queryable {
  // EN: Which backend is in use. / ES: Qué backend se está usando.
  readonly kind: 'pglite' | 'pg';
  // EN: Runs a multi-statement SQL script (migrations). / ES: Ejecuta un script SQL de varias sentencias (migraciones).
  exec(sql: string): Promise<void>;
  // EN: Runs `fn` inside BEGIN/COMMIT; any throw rolls back. / ES: Ejecuta `fn` dentro de BEGIN/COMMIT; cualquier error hace rollback.
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * EN: In-process Postgres (PGlite). `dataDir` undefined ⇒ in-memory database.
 * ES: Postgres en proceso (PGlite). `dataDir` undefined ⇒ base de datos en memoria.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const pgl = dataDir ? new PGlite(dataDir) : new PGlite();
  await pgl.waitReady;
  // EN: PGlite is single-connection; we add our own mutex so that a transaction and an
  //     outside query never interleave on the same session.
  // ES: PGlite es de una sola conexión; agregamos un mutex propio para que una transacción y
  //     una consulta externa nunca se intercalen en la misma sesión.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    kind: 'pglite',
    query: (sql, params) => serial(() => pgl.query(sql, params as unknown[]) as never),
    exec: (sql) => serial(async () => void (await pgl.exec(sql))),
    transaction: (fn) =>
      serial(() =>
        pgl.transaction(async (tx) => fn({ query: (sql, params) => tx.query(sql, params as unknown[]) as never })),
      ),
    close: () => serial(() => pgl.close()),
  };
}

/**
 * EN: Production adapter over a `pg` connection pool.
 * ES: Adaptador de producción sobre un pool de conexiones `pg`.
 */
export function createPgPoolDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    kind: 'pg',
    query: async (sql, params) => {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      // EN: Dedicated client for the whole transaction. / ES: Cliente dedicado para toda la transacción.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }) });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * EN: Picks the backend from env: DATABASE_URL ⇒ Postgres, otherwise PGlite (PGLITE_DIR or memory).
 * ES: Elige el backend según env: DATABASE_URL ⇒ Postgres, si no PGlite (PGLITE_DIR o memoria).
 */
export async function createDbFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  if (env.DATABASE_URL) return createPgPoolDb(env.DATABASE_URL);
  return createPgliteDb(env.PGLITE_DIR || undefined);
}
