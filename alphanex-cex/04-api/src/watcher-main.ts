/**
 * EN: Deposit watcher + withdrawal confirmer + periodic reconciliation, as a separate process
 *     (one instance only: it is the single writer of the watcher state).
 *     NOTE: it shares the database with the API. With PGlite (no DATABASE_URL) the two processes
 *     cannot share a DB, so use Postgres (docker compose) when running it.
 * ES: Watcher de depósitos + confirmador de retiros + conciliación periódica, como proceso separado
 *     (una sola instancia: es el único escritor del estado del watcher).
 *     NOTA: comparte la base con la API. Con PGlite (sin DATABASE_URL) los dos procesos no pueden
 *     compartir BD, así que usar Postgres (docker compose) para correrlo.
 */
import { createDbFromEnv } from '@alphanex/ledger';
import { DepositWatcher, ViemChainReader } from '@alphanex/custody';
import { createServices } from './app.js';
import { loadConfig } from './config.js';
import { ViemChainGateway } from './services/chain-gateway.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // EN: The watcher is useless without a node; fail fast instead of silently idling.
  // ES: El watcher no sirve sin un nodo; falla rápido en vez de quedar inactivo en silencio.
  if (!config.rpcUrl) throw new Error('RPC_URL is required');
  if (!process.env.DATABASE_URL) console.warn('[watcher] DATABASE_URL not set: using an isolated PGlite DB (demo only)');
  const db = await createDbFromEnv();
  const chain = new ViemChainReader(config.rpcUrl);
  // EN: Same service layer as the API (same DB, same ledger rules) — but no HTTP server in this process.
  // ES: Misma capa de servicios que la API (misma BD, mismas reglas de ledger) — pero sin servidor HTTP en este proceso.
  const s = await createServices({ config, db, chain, gateway: new ViemChainGateway(config.rpcUrl) });
  const watcher = new DepositWatcher({
    chain,
    sink: s.deposits.sink(),
    store: s.deposits.store(),
    assets: s.watched,
    // EN: Optional first block to scan on a fresh DB (later runs resume from the persisted cursor).
    // ES: Bloque inicial opcional para una BD nueva (las corridas siguientes retoman desde el cursor guardado).
    startBlock: process.env.WATCHER_START_BLOCK ? BigInt(process.env.WATCHER_START_BLOCK) : undefined,
  });
  const pollMs = Number(process.env.WATCHER_POLL_MS ?? 4000);
  const reconMs = Number(process.env.RECONCILE_EVERY_MS ?? 300_000);
  let lastRecon = 0;
  let stop = false;
  // EN: Graceful stop: finish the current iteration, then close the DB.
  // ES: Parada ordenada: termina la iteración actual y luego cierra la BD.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop = true));
  while (!stop) {
    try {
      const r = await watcher.poll();
      if (r.scanned || r.credited || r.orphaned || r.critical) console.log('[watcher]', JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      // EN: Same loop also finalizes broadcast withdrawals once their receipt is mined.
      // ES: El mismo bucle también finaliza retiros difundidos cuando su recibo queda minado.
      const c = await s.withdrawals.confirmBroadcasts();
      if (c) console.log(`[watcher] finalized ${c} withdrawal(s)`);
      // EN: Periodic reconciliation; a deficit raises a critical alert AND halts withdrawals automatically.
      // ES: Conciliación periódica; un déficit dispara una alerta crítica Y detiene los retiros automáticamente.
      if (Date.now() - lastRecon > reconMs) {
        lastRecon = Date.now();
        const rep = await s.admin.reconcile().catch((e: Error) => ({ ok: false, error: e.message }));
        console.log('[recon]', JSON.stringify((rep as { human?: unknown }).human ?? rep));
      }
    } catch (e) {
      // EN: RPC hiccups must not kill the loop. / ES: Fallas del RPC no deben matar el loop.
      console.error('[watcher] poll error:', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  await db.close?.();
}

main().catch((e) => {
  console.error('[watcher] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
