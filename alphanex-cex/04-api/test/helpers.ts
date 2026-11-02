/**
 * EN: Test harness: in-memory PGlite DB + app built with test config. Nothing touches the network.
 * ES: Arnés de tests: BD PGlite en memoria + app construida con config de test. Nada toca la red.
 */
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { createPgliteDb, type Db } from '@alphanex/ledger';
import { buildApp, loadConfig, type AppDeps } from '../src/index.js';

// EN: Random password per run (never hardcode credentials). / ES: Contraseña aleatoria por corrida (nunca hardcodear credenciales).
// EN: Random per-run password: no credential is committed in the tests.
// ES: Contraseña aleatoria por corrida: ningún credencial queda en los tests.
export const PW = `pw-${randomBytes(9).toString('base64url')}`;

/** EN: Fresh random xpub at m/44'/60'/0'/0 (test only). / ES: xpub aleatoria nueva en m/44'/60'/0'/0 (solo test). */
export function randomXpub(): string {
  // EN: Fresh random xpub per test run (only public material reaches the API).
  // ES: xpub aleatorio por corrida (a la API solo llega material público).
  return HDKey.fromMasterSeed(randomBytes(32)).derive("m/44'/60'/0'/0").publicExtendedKey;
}

export async function makeApp(env: Record<string, string> = {}, extra: Partial<AppDeps> = {}, db?: Db) {
  // EN: In-memory PGlite DB per app instance: tests are isolated and fully offline.
  // ES: BD PGlite en memoria por instancia: los tests están aislados y son totalmente offline.
  const config = loadConfig({ ALLOW_DEV_FAUCET: 'true', AUTH_RATE_LIMIT_PER_MINUTE: '1000', ...env });
  const database = db ?? (await createPgliteDb());
  const built = await buildApp({ config, db: database, ...extra });
  await built.app.ready();
  return { ...built, db: database, config };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

/** EN: Small JSON request helper on top of inject. / ES: Pequeño helper JSON sobre inject. */
export async function call(app: App, method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  // EN: Fastify inject = no real socket is opened.
  // ES: Fastify inject = no se abre ningún socket real.
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: opts.body as object | undefined,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
  });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* EN: empty body / ES: cuerpo vacío */
  }
  return { status: res.statusCode, json, headers: res.headers };
}

/** EN: Registers + logs in; returns token and id. / ES: Registra + loguea; devuelve token e id. */
export async function user(app: App, email: string) {
  await call(app, 'POST', '/auth/register', { body: { email, password: PW } });
  const r = await call(app, 'POST', '/auth/login', { body: { email, password: PW } });
  return { token: r.json.token as string, id: r.json.user.id as string };
}

/** EN: Balances of the logged-in user. / ES: Saldos del usuario logueado. */
export async function balances(app: App, token: string) {
  return (await call(app, 'GET', '/account/balances', { token })).json.balances as Record<string, { available: string; locked: string; withdrawing: string }>;
}
