/**
 * EN: Tiny forward-only migration runner. Each file runs once, inside a transaction, and is
 *     recorded in `schema_migrations`. Files are applied in lexical order (001_, 002_...).
 * ES: Runner de migraciones mínimo, solo hacia adelante. Cada archivo corre una vez, dentro de una
 *     transacción, y queda registrado en `schema_migrations`. Se aplican en orden léxico (001_, 002_...).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';

export interface Migration {
  // EN: Unique name, e.g. "ledger/001_ledger.sql". / ES: Nombre único, ej. "ledger/001_ledger.sql".
  name: string;
  sql: string;
}

/**
 * EN: Loads every *.sql file from a directory, prefixing names with `namespace`.
 * ES: Carga todos los *.sql de un directorio, anteponiendo `namespace` a los nombres.
 */
export function loadMigrations(dir: string, namespace: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: `${namespace}/${f}`, sql: readFileSync(join(dir, f), 'utf8') }));
}

/**
 * EN: Applies pending migrations. Returns the names that were applied in this call.
 * ES: Aplica migraciones pendientes. Devuelve los nombres aplicados en esta llamada.
 */
export async function runMigrations(db: Db, migrations: Migration[]): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    // EN: exec() can run multiple statements; wrap in BEGIN/COMMIT so a broken file leaves no trace.
    // ES: exec() corre varias sentencias; lo envolvemos en BEGIN/COMMIT para que un archivo roto no deje rastro.
    await db.exec(`BEGIN;\n${m.sql}\n;INSERT INTO schema_migrations(name) VALUES ('${m.name.replace(/'/g, "''")}');\nCOMMIT;`).catch(async (e) => {
      await db.exec('ROLLBACK').catch(() => undefined);
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
    });
    applied.push(m.name);
  }
  return applied;
}

/**
 * EN: Absolute path of this package's own migrations folder.
 * ES: Ruta absoluta de la carpeta de migraciones de este paquete.
 */
export const LEDGER_MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;
