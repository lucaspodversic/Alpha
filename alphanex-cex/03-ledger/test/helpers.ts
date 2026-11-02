/**
 * EN: Test helpers: fresh in-memory Postgres (PGlite) with migrations and seed assets.
 * ES: Utilidades de test: Postgres en memoria (PGlite) nuevo con migraciones y activos semilla.
 */
import { createPgliteDb, ExchangeAccounting, Ledger } from '../src/index.js';

export async function setup() {
  const db = await createPgliteDb();
  const ledger = new Ledger(db);
  await ledger.migrate();
  await ledger.upsertAsset({ code: 'USDT', decimals: 6, kind: 'erc20' });
  await ledger.upsertAsset({ code: 'ETH', decimals: 18, kind: 'native' });
  return { db, ledger, acct: new ExchangeAccounting(ledger) };
}
