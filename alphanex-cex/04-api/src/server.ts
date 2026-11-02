/**
 * EN: API process entry point. Reads env, connects the DB (Postgres via DATABASE_URL, else PGlite),
 *     optionally wires the chain gateway + signer client, and listens (127.0.0.1 by default).
 * ES: Punto de entrada del proceso API. Lee el entorno, conecta la BD (Postgres vía DATABASE_URL,
 *     si no PGlite), opcionalmente conecta gateway de cadena + cliente firmante, y escucha (127.0.0.1 por defecto).
 */
import { createDbFromEnv } from '@alphanex/ledger';
import { ViemChainReader } from '@alphanex/custody';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { HttpSignerClient, ViemChainGateway } from './services/chain-gateway.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // EN: DATABASE_URL → Postgres; otherwise an embedded PGlite DB (dev only).
  // ES: DATABASE_URL → Postgres; si no, una BD PGlite embebida (solo dev).
  const db = await createDbFromEnv();
  const { app } = await buildApp({
    config,
    db,
    logger: true,
    gateway: config.rpcUrl ? new ViemChainGateway(config.rpcUrl) : undefined,
    chain: config.rpcUrl ? new ViemChainReader(config.rpcUrl) : undefined,
    // EN: Custody pieces are wired only when configured; without them, withdrawals answer 503.
    // ES: Las piezas de custodia se conectan solo si están configuradas; sin ellas los retiros responden 503.
    signer: config.signerUrl && config.signerHmacSecret ? new HttpSignerClient(config.signerUrl, config.signerHmacSecret) : undefined,
    // EN: Optional first admin(s): ADMIN_EMAIL/ADMIN_PASSWORD (+ ADMIN2_* for the two-person rule).
    // ES: Admin(s) iniciales opcionales: ADMIN_EMAIL/ADMIN_PASSWORD (+ ADMIN2_* para la regla de dos personas).
    // EN: Up to two admins from env (two are needed for four-eyes approval). Never hardcoded.
    // ES: Hasta dos admins desde env (hacen falta dos para la aprobación de cuatro ojos). Nunca hardcodeados.
    bootstrapAdmins: [
      ['ADMIN_EMAIL', 'ADMIN_PASSWORD'],
      ['ADMIN2_EMAIL', 'ADMIN2_PASSWORD'],
    ]
      .filter(([e, p]) => process.env[e!] && process.env[p!])
      .map(([e, p]) => ({ email: process.env[e!]!, password: process.env[p!]! })),
  });
  // EN: Graceful shutdown. / ES: Apagado ordenado.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
  // EN: Binds to 127.0.0.1 unless HOST is changed explicitly.
  // ES: Escucha en 127.0.0.1 salvo que HOST se cambie explícitamente.
  await app.listen({ host: config.host, port: config.port });
}

main().catch((e) => {
  console.error('[api] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
