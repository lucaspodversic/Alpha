/**
 * EN: Fastify application factory: wires DB, ledger, services, REST routes and the WebSocket feed.
 *     `buildApp` is used by the server entry point and by the tests (with PGlite and fake chain).
 * ES: Fábrica de la aplicación Fastify: conecta BD, ledger, servicios, rutas REST y el feed WebSocket.
 *     `buildApp` lo usan el punto de entrada del servidor y los tests (con PGlite y cadena falsa).
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { SEED_ASSETS, SEED_MARKETS } from '@alphanex/matching-engine';
import { ExchangeAccounting, Ledger, loadMigrations, runMigrations, type Db } from '@alphanex/ledger';
import type { ChainReader, WatchedAsset } from '@alphanex/custody';
import type { Address } from 'viem';
import type { AppConfig } from './config.js';
import { ApiError, forbidden, unauthorized } from './errors.js';
import { EventBus } from './events.js';
import { withIdempotency } from './idempotency.js';
import { jsonSafe, sha256 } from './util.js';
import { AuditLog } from './services/audit.js';
import { AuthService, type SessionUser } from './services/auth.js';
import { ExchangeService, specToJson, type PlaceOrderInput } from './services/exchange.js';
import { WithdrawalService, type AssetInfo } from './services/withdrawals.js';
import { DepositService } from './services/deposits.js';
import { AdminService } from './services/admin.js';
import type { ChainGateway, SignerClient } from './services/chain-gateway.js';

// EN: SQL migrations of this package. / ES: Migraciones SQL de este paquete.
export const API_MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;

// EN: Every request carries the authenticated session user (or null); set by the onRequest hook below.
// ES: Cada request lleva el usuario de la sesión autenticada (o null); lo asigna el hook onRequest de abajo.
declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

// EN: Everything the app needs injected. Chain pieces are optional so tests and dev can run fully offline.
// ES: Todo lo que la app necesita inyectado. Las piezas de cadena son opcionales para que tests y dev corran offline.
export interface AppDeps {
  config: AppConfig;
  db: Db;
  // EN: Optional custody adapters (absent = deposits/withdrawal processing disabled with 503).
  // ES: Adaptadores de custodia opcionales (ausentes = depósitos/procesamiento de retiros deshabilitados con 503).
  gateway?: ChainGateway;
  signer?: SignerClient;
  chain?: ChainReader;
  // EN: Admins created at boot if missing (from ADMIN_* env). / ES: Admins creados al arrancar si faltan (de ADMIN_* env).
  bootstrapAdmins?: { email: string; password: string }[];
  logger?: boolean;
}

// EN: The wired service graph, returned so tests / the watcher process can drive services directly.
// ES: El grafo de servicios armado; se devuelve para que tests / el proceso watcher usen los servicios directamente.
export interface Services {
  db: Db;
  bus: EventBus;
  ledger: Ledger;
  acct: ExchangeAccounting;
  audit: AuditLog;
  auth: AuthService;
  exchange: ExchangeService;
  withdrawals: WithdrawalService;
  deposits: DepositService;
  admin: AdminService;
  watched: (WatchedAsset & { confirmations: number })[];
}

/**
 * EN: Creates services, runs migrations and seeds reference data. Shared by API and watcher processes.
 * ES: Crea servicios, corre migraciones y siembra datos de referencia. Compartido por API y watcher.
 */
export async function createServices(deps: AppDeps): Promise<Services> {
  const { config, db } = deps;
  // EN: Schema first: ledger tables, then API tables (users, orders, trades, withdrawals, audit...).
  // ES: Primero el esquema: tablas del ledger y luego las de la API (usuarios, órdenes, trades, retiros, auditoría...).
  const ledger = new Ledger(db);
  await ledger.migrate();
  await runMigrations(db, loadMigrations(API_MIGRATIONS_DIR, 'api'));
  // EN: Assets + markets (idempotent). / ES: Activos + mercados (idempotente).
  // EN: Seed assets idempotently. A token is only watched on-chain if its contract address is configured;
  //     ETH (native) is always watched. Confirmation depth can be overridden per asset from env.
  // ES: Sembrar activos de forma idempotente. Un token solo se vigila on-chain si tiene contrato configurado;
  //     ETH (nativo) siempre se vigila. La profundidad de confirmación se puede sobrescribir por activo desde env.
  const watched: Services['watched'] = [];
  for (const a of SEED_ASSETS) {
    const contract = config.tokenContracts[a.code];
    const confirmations = config.confirmations[a.code] ?? a.confirmations;
    await ledger.upsertAsset({ code: a.code, decimals: a.decimals, kind: a.kind, contractAddress: contract ?? null, confirmations });
    if (a.kind === 'native' || contract) watched.push({ code: a.code, kind: a.kind, contract: contract as Address | undefined, confirmations });
  }
  // EN: Markets are seeded once; an existing row (maybe frozen by ops) is never overwritten.
  // ES: Los mercados se siembran una vez; una fila existente (quizá congelada por ops) nunca se pisa.
  for (const m of SEED_MARKETS) {
    await db.query('INSERT INTO markets(id, base, quote, spec) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [m.id, m.base, m.quote, JSON.stringify(specToJson(m))]);
  }
  const decimals = Object.fromEntries(SEED_ASSETS.map((a) => [a.code, a.decimals]));
  const assetInfo: Record<string, AssetInfo> = Object.fromEntries(SEED_ASSETS.map((a) => [a.code, { code: a.code, decimals: a.decimals, kind: a.kind }]));

  // EN: Wiring order matters: exchange.init() rebuilds every in-memory book from open orders in the DB.
  // ES: El orden importa: exchange.init() reconstruye cada libro en memoria desde las órdenes abiertas de la BD.
  const bus = new EventBus();
  const acct = new ExchangeAccounting(ledger);
  const audit = new AuditLog(db);
  const auth = new AuthService(db, audit, config.sessionTtlMs);
  const exchange = new ExchangeService(db, acct, audit, bus);
  await exchange.init();
  const withdrawals = new WithdrawalService(db, acct, audit, bus, assetInfo, {
    chainId: config.chainId,
    hotWalletAddress: config.hotWalletAddress,
    gateway: deps.gateway,
    signer: deps.signer,
  });
  // EN: Late-bound to break the deposits ↔ admin cycle. / ES: Enlace tardío para romper el ciclo depósitos ↔ admin.
  // EN: Deposits and admin depend on each other (a critical reorg must freeze the user through the admin
  //     service so it is audited and orders get canceled), so admin is bound late through this closure.
  // ES: Depósitos y admin dependen entre sí (un reorg crítico debe congelar al usuario vía el servicio admin
  //     para que quede auditado y se cancelen sus órdenes), por eso admin se enlaza tarde con esta clausura.
  let admin: AdminService | undefined;
  const deposits = new DepositService(db, acct, audit, bus, config.depositXpub, decimals, async (userId, reason) => {
    await admin!.setUserFrozen('system', userId, true, reason);
  });
  admin = new AdminService(db, ledger, audit, bus, exchange, withdrawals, deposits, decimals, {
    allowDevFaucet: config.allowDevFaucet,
    chain: deps.chain,
    watched,
    hotWalletAddress: config.hotWalletAddress,
  });
  // EN: Bootstrap admins from env only if they do not exist yet (never resets a password).
  // ES: Crear admins iniciales desde env solo si todavía no existen (nunca resetea una contraseña).
  for (const a of deps.bootstrapAdmins ?? []) {
    const ex = await db.query('SELECT 1 FROM users WHERE email = $1', [a.email.toLowerCase()]);
    if (!ex.rows.length) await auth.register(a.email, a.password, 'admin');
  }
  return { db, bus, ledger, acct, audit, auth, exchange, withdrawals, deposits, admin, watched };
}

/** EN: Bearer token from the Authorization header. / ES: Token bearer del header Authorization. */
function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/** EN: Requires a logged-in user. / ES: Requiere usuario logueado. */
function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
/** EN: Requires an admin. / ES: Requiere admin. */
function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== 'admin') throw forbidden('admin_only');
  return u;
}

// EN: Reusable JSON-schema fragments (Fastify validates bodies before handlers run).
// ES: Fragmentos JSON-schema reutilizables (Fastify valida los cuerpos antes de los handlers).
// EN: Amounts travel as decimal STRINGS (never JSON numbers) to avoid float rounding; services check scale.
// ES: Los montos viajan como STRINGS decimales (nunca números JSON) para evitar redondeos float; los servicios validan la escala.
const decimalStr = { type: 'string', pattern: '^[0-9]{1,40}(\\.[0-9]{1,36})?$' } as const;
const credsSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: { email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 200 } },
  },
} as const;

/**
 * EN: Builds the HTTP app. / ES: Construye la app HTTP.
 */
export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; services: Services }> {
  const { config } = deps;
  const s = await createServices(deps);
  // EN: 64 KiB body limit; trustProxy off so req.ip cannot be spoofed via X-Forwarded-For (enable only behind a known proxy).
  // ES: Límite de 64 KiB; trustProxy apagado para que req.ip no se falsee con X-Forwarded-For (activar solo detrás de un proxy conocido).
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 64 * 1024, trustProxy: false });

  // EN: CORS: explicit allow-list of UI origins, no cookies (auth is a Bearer header).
  // ES: CORS: lista explícita de orígenes de la UI, sin cookies (la auth es un header Bearer).
  await app.register(cors, { origin: config.corsOrigin, credentials: false, allowedHeaders: ['content-type', 'authorization', 'idempotency-key'] });
  // EN: Global rate limit keyed by session token hash (or IP if anonymous). / ES: Rate limit global por hash del token (o IP si anónimo).
  // EN: Global rate limit keyed by session (hashed token) or by IP for anonymous callers.
  // ES: Rate limit global por sesión (token hasheado) o por IP para llamadas anónimas.
  await app.register(rateLimit, {
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const t = bearer(req);
      return t ? `t:${sha256(t)}` : `ip:${req.ip}`;
    },
  });
  // EN: Small WS frames only: clients send tiny control messages (auth / subscribe).
  // ES: Solo frames WS chicos: los clientes mandan mensajes de control mínimos (auth / subscribe).
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.decorateRequest('user', null);
  // EN: Resolve the session on every request (cheap indexed lookup). / ES: Resolver la sesión en cada request (búsqueda indexada barata).
  app.addHook('onRequest', async (req) => {
    req.user = await s.auth.authenticate(bearer(req));
  });
  // EN: Basic hardening headers. / ES: Headers básicos de endurecimiento.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });
  // EN: bigint-safe JSON. / ES: JSON seguro para bigint.
  app.addHook('preSerialization', async (_req, _reply, payload) => jsonSafe(payload));

  // EN: Uniform error shape {error, message}. Unknown errors are logged and returned as a generic 500
  //     so stack traces / SQL never leak to clients.
  // ES: Forma de error uniforme {error, message}. Los errores desconocidos se loguean y se devuelven como 500
  //     genérico para que nunca se filtren stack traces / SQL a los clientes.
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err.validation) return reply.code(400).send({ error: 'validation', message: err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'rate_limited', message: err.message });
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    // EN: Never leak internals. / ES: Nunca filtrar detalles internos.
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  // EN: Stricter per-IP limit on register/login to slow credential stuffing.
  // ES: Límite más estricto por IP en registro/login para frenar credential stuffing.
  const authLimit = { rateLimit: { max: config.authRateLimitPerMinute, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `auth:${r.ip}` } };

  // ---------------------------------------------------------------- health
  app.get('/health', async () => ({ ok: true, chainId: config.chainId }));

  // ---------------------------------------------------------------- auth
  app.post('/auth/register', { schema: credsSchema, config: authLimit }, async (req, reply) => {
    const b = req.body as { email: string; password: string };
    const user = await s.auth.register(b.email, b.password);
    return reply.code(201).send({ user });
  });
  app.post('/auth/login', { schema: credsSchema, config: authLimit }, async (req) => {
    const b = req.body as { email: string; password: string };
    return s.auth.login(b.email, b.password);
  });
  // EN: Logout deletes the session row; the token becomes useless immediately.
  // ES: Logout borra la fila de sesión; el token deja de servir al instante.
  app.post('/auth/logout', async (req, reply) => {
    requireUser(req);
    await s.auth.logout(bearer(req)!);
    return reply.code(204).send();
  });
  app.get('/auth/me', async (req) => ({ user: requireUser(req) }));
  // EN: Wallet linking = one-time nonce challenge + EIP-191 signature check (see AuthService).
  // ES: Vincular wallet = desafío con nonce de un solo uso + verificación de firma EIP-191 (ver AuthService).
  app.post('/auth/wallet/challenge', { schema: { body: { type: 'object', required: ['address'], properties: { address: { type: 'string' } } } }, config: authLimit }, async (req) =>
    s.auth.walletChallenge(requireUser(req).id, (req.body as { address: string }).address),
  );
  app.post(
    '/auth/wallet/link',
    { schema: { body: { type: 'object', required: ['address', 'signature'], properties: { address: { type: 'string' }, signature: { type: 'string', maxLength: 300 } } } }, config: authLimit },
    async (req) => {
      const b = req.body as { address: string; signature: string };
      return { user: await s.auth.linkWallet(requireUser(req).id, b.address, b.signature) };
    },
  );

  // ---------------------------------------------------------------- market data (public)
  app.get('/markets', async () => ({ markets: s.exchange.listMarkets() }));
  // EN: Public market data: aggregated depth, recent trades, OHLCV candles and 24h ticker.
  // ES: Datos públicos de mercado: profundidad agregada, trades recientes, velas OHLCV y ticker 24h.
  app.get('/markets/:id/book', async (req) => {
    const q = req.query as { levels?: string };
    return s.exchange.depth((req.params as { id: string }).id, Number(q.levels ?? 20) || 20);
  });
  app.get('/markets/:id/trades', async (req) => ({ trades: await s.exchange.recentTrades((req.params as { id: string }).id, Number((req.query as { limit?: string }).limit ?? 50) || 50) }));
  app.get('/markets/:id/candles', async (req) => {
    const q = req.query as { interval?: string; limit?: string };
    return { candles: await s.exchange.candles((req.params as { id: string }).id, Number(q.interval ?? 60) || 60, Number(q.limit ?? 200) || 200) };
  });
  app.get('/markets/:id/ticker', async (req) => s.exchange.ticker((req.params as { id: string }).id));

  // ---------------------------------------------------------------- orders
  app.post(
    '/orders',
    {
      schema: {
        body: {
          type: 'object',
          required: ['market', 'side', 'type', 'qty'],
          additionalProperties: false,
          properties: {
            market: { type: 'string', maxLength: 32 },
            side: { enum: ['buy', 'sell'] },
            type: { enum: ['limit', 'market'] },
            tif: { enum: ['GTC', 'IOC', 'POST_ONLY'] },
            price: decimalStr,
            qty: decimalStr,
            clientOrderId: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      // EN: Order placement is idempotent per user + Idempotency-Key: a retried request replays the stored response.
      // ES: Colocar órdenes es idempotente por usuario + Idempotency-Key: un reintento devuelve la respuesta guardada.
      return withIdempotency(s.db, u.id, req, reply, async () => ({ status: 201, body: { order: await s.exchange.placeOrder(u.id, req.body as PlaceOrderInput) } }));
    },
  );
  app.get('/orders', async (req) => {
    const q = req.query as { open?: string; market?: string; limit?: string };
    return { orders: await s.exchange.listOrders(requireUser(req).id, { open: q.open === 'true', market: q.market, limit: Number(q.limit ?? 100) || 100 }) };
  });
  app.get('/orders/:id', async (req) => {
    const u = requireUser(req);
    const id = (req.params as { id: string }).id;
    // EN: Ownership check: 404 (not 403) so other users' order ids cannot be probed.
    // ES: Chequeo de dueño: 404 (no 403) para que no se puedan sondear ids de órdenes ajenas.
    const own = await s.db.query('SELECT 1 FROM orders WHERE id = $1 AND user_id = $2', [id, u.id]);
    if (!own.rows.length) throw new ApiError(404, 'order_not_found');
    return { order: await s.exchange.getOrder(id) };
  });
  app.delete('/orders/:id', async (req) => ({ order: await s.exchange.cancelOrder(requireUser(req).id, (req.params as { id: string }).id) }));
  app.delete('/orders', async (req) => {
    const u = requireUser(req);
    const market = (req.query as { market?: string }).market;
    return { canceled: await s.exchange.cancelAllForUser(u.id, u.id, 'user_cancel_all', market) };
  });

  // ---------------------------------------------------------------- account
  // EN: Balances are read from the ledger (source of truth) and formatted per asset decimals.
  // ES: Los saldos se leen del ledger (fuente de verdad) y se formatean según los decimales del activo.
  app.get('/account/balances', async (req) => {
    const b = await s.ledger.userBalances(requireUser(req).id);
    const dec = Object.fromEntries(SEED_ASSETS.map((a) => [a.code, a.decimals]));
    const { formatUnits } = await import('@alphanex/matching-engine');
    const out: Record<string, { available: string; locked: string; withdrawing: string }> = {};
    for (const a of SEED_ASSETS) {
      const x = b[a.code];
      out[a.code] = {
        available: formatUnits(x?.available ?? 0n, dec[a.code]!),
        locked: formatUnits(x?.locked ?? 0n, dec[a.code]!),
        withdrawing: formatUnits(x?.withdrawing ?? 0n, dec[a.code]!),
      };
    }
    return { balances: out };
  });
  // EN: Deposit address is derived from the xpub on first request and then stays fixed for the user.
  // ES: La dirección de depósito se deriva de la xpub en el primer pedido y luego queda fija para el usuario.
  app.get('/account/deposit-address', async (req) => {
    const r = await s.deposits.addressFor(requireUser(req).id);
    return { ...r, chainId: config.chainId, assets: s.watched.map((w) => ({ code: w.code, kind: w.kind, contract: w.contract ?? null, confirmations: w.confirmations })) };
  });
  app.get('/account/deposits', async (req) => ({ deposits: await s.deposits.list(requireUser(req).id) }));
  app.get('/account/withdrawals', async (req) => ({ withdrawals: await s.withdrawals.list({ userId: requireUser(req).id }) }));
  app.post(
    '/account/withdrawals',
    {
      schema: {
        body: {
          type: 'object',
          required: ['asset', 'to', 'amount'],
          additionalProperties: false,
          properties: { asset: { type: 'string', maxLength: 16 }, to: { type: 'string', maxLength: 64 }, amount: decimalStr },
        },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      // EN: Withdrawal request: idempotent, reserves amount + fee, then waits for two admin approvals.
      // ES: Pedido de retiro: idempotente, reserva monto + fee y luego espera dos aprobaciones de admins.
      return withIdempotency(s.db, u.id, req, reply, async () => ({ status: 201, body: { withdrawal: await s.withdrawals.request(u.id, req.body as { asset: string; to: string; amount: string }) } }));
    },
  );
  app.get('/account/trades', async (req) => ({ trades: await s.exchange.userTrades(requireUser(req).id) }));
  app.get('/account/withdrawal-limits', async (req) => {
    requireUser(req);
    return { limits: await s.withdrawals.getLimits() };
  });

  // ---------------------------------------------------------------- admin
  // EN: Admin / ops. Every mutating admin action requires a human-readable reason and is written to the audit chain.
  // ES: Admin / ops. Toda acción de admin que modifica algo exige un motivo legible y se escribe en la cadena de auditoría.
  const reason = { type: 'string', minLength: 3, maxLength: 500 } as const;
  app.get('/admin/users', async (req) => {
    requireAdmin(req);
    return { users: await s.admin.users() };
  });
  // EN: User kill switch: freezing cancels open orders and blocks trading and withdrawals.
  // ES: Interruptor de usuario: congelar cancela órdenes abiertas y bloquea trading y retiros.
  app.post('/admin/users/:id/freeze', { schema: { body: { type: 'object', required: ['frozen', 'reason'], properties: { frozen: { type: 'boolean' }, reason } } } }, async (req) => {
    const a = requireAdmin(req);
    const b = req.body as { frozen: boolean; reason: string };
    return s.admin.setUserFrozen(a.id, (req.params as { id: string }).id, b.frozen, b.reason);
  });
  // EN: Market kill switch: no new orders; cancels are still allowed so users can exit.
  // ES: Interruptor de mercado: no entran órdenes nuevas; cancelar sigue permitido para que los usuarios salgan.
  app.post('/admin/markets/:id/freeze', { schema: { body: { type: 'object', required: ['frozen', 'reason'], properties: { frozen: { type: 'boolean' }, reason } } } }, async (req) => {
    const a = requireAdmin(req);
    const b = req.body as { frozen: boolean; reason: string };
    await s.exchange.setMarketFrozen((req.params as { id: string }).id, b.frozen, a.id, b.reason);
    return { ok: true };
  });
  app.get('/admin/withdrawals', async (req) => {
    requireAdmin(req);
    return { withdrawals: await s.withdrawals.list({ status: (req.query as { status?: string }).status }) };
  });
  // EN: Four-eyes flow: approve (2 distinct admins, never the requester) → process (sign + broadcast) → confirm.
  // ES: Flujo de cuatro ojos: aprobar (2 admins distintos, nunca el solicitante) → procesar (firmar + difundir) → confirmar.
  app.post('/admin/withdrawals/:id/approve', async (req) => ({ withdrawal: await s.withdrawals.approve(requireAdmin(req).id, (req.params as { id: string }).id) }));
  app.post('/admin/withdrawals/:id/reject', { schema: { body: { type: 'object', required: ['reason'], properties: { reason } } } }, async (req) => ({
    withdrawal: await s.withdrawals.reject(requireAdmin(req).id, (req.params as { id: string }).id, (req.body as { reason: string }).reason),
  }));
  app.post('/admin/withdrawals/:id/process', async (req) => ({ withdrawal: await s.withdrawals.process(requireAdmin(req).id, (req.params as { id: string }).id) }));
  app.post('/admin/withdrawals/confirm', async (req) => {
    requireAdmin(req);
    return { changed: await s.withdrawals.confirmBroadcasts() };
  });
  // EN: Global withdrawal kill switch (also set automatically by a reconciliation deficit).
  // ES: Interruptor global de retiros (también lo activa automáticamente un déficit de conciliación).
  app.get('/admin/withdrawals/halt', async (req) => {
    requireAdmin(req);
    return s.withdrawals.haltStatus();
  });
  app.post('/admin/withdrawals/halt', { schema: { body: { type: 'object', required: ['halted', 'reason'], additionalProperties: false, properties: { halted: { type: 'boolean' }, reason } } } }, async (req) => {
    const b = req.body as { halted: boolean; reason: string };
    await s.withdrawals.setHalted(requireAdmin(req).id, b.halted, b.reason);
    return s.withdrawals.haltStatus();
  });
  app.get('/admin/limits', async (req) => {
    requireAdmin(req);
    return { limits: await s.withdrawals.getLimits() };
  });
  app.put(
    '/admin/limits/:asset',
    { schema: { body: { type: 'object', required: ['perTxMax', 'dailyMax', 'fee'], additionalProperties: false, properties: { perTxMax: decimalStr, dailyMax: decimalStr, fee: decimalStr } } } },
    async (req) => {
      await s.withdrawals.setLimits(requireAdmin(req).id, (req.params as { asset: string }).asset, req.body as { perTxMax: string; dailyMax: string; fee: string });
      return { limits: await s.withdrawals.getLimits() };
    },
  );
  app.get('/admin/audit', async (req) => {
    requireAdmin(req);
    const q = req.query as { limit?: string; action?: string };
    return { entries: await s.audit.list(Number(q.limit ?? 100) || 100, q.action) };
  });
  app.get('/admin/audit/verify', async (req) => {
    requireAdmin(req);
    return s.audit.verify();
  });
  // EN: Ledger self-check (balanced entries, no drift, books close, no forbidden negatives).
  // ES: Autochequeo del ledger (asientos balanceados, sin deriva, libros cierran, sin negativos prohibidos).
  app.get('/admin/invariants', async (req) => {
    requireAdmin(req);
    return s.admin.invariants();
  });
  // EN: On-chain vs ledger custody comparison; a deficit freezes withdrawals.
  // ES: Comparación custodia on-chain vs ledger; un déficit congela los retiros.
  app.post('/admin/reconcile', async (req) => {
    requireAdmin(req);
    return s.admin.reconcile();
  });
  app.post(
    // EN: Books venue capital sent to the hot wallet (e.g. gas ETH) as equity, so custody stays reconciled.
    // ES: Registra capital propio enviado a la hot wallet (ej. ETH para gas) como patrimonio, para que la custodia siga conciliada.
    '/admin/treasury/fund',
    { schema: { body: { type: 'object', required: ['asset', 'amount', 'ref'], properties: { asset: { type: 'string' }, amount: decimalStr, ref: { type: 'string' } } } } },
    async (req) => {
      const b = req.body as { asset: string; amount: string; ref: string };
      await s.admin.bookTreasuryFunding(requireAdmin(req).id, b.asset, b.amount, b.ref);
      return { ok: true };
    },
  );
  // EN: DEV faucet: any logged-in user can top up THEMSELVES only when enabled (local demo).
  // ES: Faucet DEV: cualquier usuario logueado puede recargarse A SÍ MISMO solo si está habilitado (demo local).
  app.post(
    '/dev/faucet',
    { schema: { body: { type: 'object', required: ['asset', 'amount'], additionalProperties: false, properties: { asset: { type: 'string' }, amount: decimalStr } } } },
    async (req) => {
      const u = requireUser(req);
      const b = req.body as { asset: string; amount: string };
      await s.admin.devCredit(u.id, u.id, b.asset, b.amount);
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------- websocket
  // EN: Real-time channels (book / trades / user / admin).
  // ES: Canales en tiempo real (libro / trades / usuario / admin).
  registerWs(app, s);

  return { app, services: s };
}

/**
 * EN: WebSocket protocol (JSON messages):
 *       → {op:"auth", token}                 ← {type:"authed"}
 *       → {op:"subscribe", channel}          ← {type:"subscribed", channel} (+ snapshot for book:*)
 *       → {op:"unsubscribe", channel}
 *       ← {type:"event", channel, data}
 *     Channels: book:<MKT>, trades:<MKT> (public), user (private, needs auth), admin (admins).
 * ES: Protocolo WebSocket (mensajes JSON):
 *       → {op:"auth", token}                 ← {type:"authed"}
 *       → {op:"subscribe", channel}          ← {type:"subscribed", channel} (+ snapshot para book:*)
 *       → {op:"unsubscribe", channel}
 *       ← {type:"event", channel, data}
 *     Canales: book:<MKT>, trades:<MKT> (públicos), user (privado, requiere auth), admin (admins).
 */
function registerWs(app: FastifyInstance, s: Services): void {
  app.get('/ws', { websocket: true }, (socket) => {
    let user: SessionUser | null = null;
    // EN: Per-socket state: optional authenticated user + map channel → unsubscribe function.
    // ES: Estado por socket: usuario autenticado opcional + mapa canal → función para desuscribirse.
    const subs = new Map<string, () => void>();
    const send = (m: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(jsonSafe(m)));
    };
    socket.on('message', async (raw: Buffer) => {
      let msg: { op?: string; token?: string; channel?: string };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return send({ type: 'error', error: 'bad_json' });
      }
      try {
        // EN: The token is sent inside the socket (never in the URL, which could end up in logs).
        // ES: El token se manda dentro del socket (nunca en la URL, que podría terminar en logs).
        if (msg.op === 'auth') {
          user = await s.auth.authenticate(msg.token);
          return send(user ? { type: 'authed', userId: user.id } : { type: 'error', error: 'unauthorized' });
        }
        const ch = String(msg.channel ?? '');
        if (msg.op === 'subscribe') {
          // EN: Cap subscriptions per socket to bound memory / fan-out cost.
          // ES: Tope de suscripciones por socket para acotar memoria / costo de fan-out.
          if (subs.size >= 20) return send({ type: 'error', error: 'too_many_subscriptions' });
          let internal: string;
          if (ch === 'user') {
            if (!user) return send({ type: 'error', error: 'unauthorized' });
            internal = `user:${user.id}`;
          } else if (ch === 'admin') {
            if (user?.role !== 'admin') return send({ type: 'error', error: 'forbidden' });
            internal = 'admin';
          } else if (/^(book|trades):[A-Z0-9-]{3,20}$/.test(ch)) {
            s.exchange.market(ch.split(':')[1]!);
            internal = ch;
          } else return send({ type: 'error', error: 'unknown_channel' });
          if (!subs.has(ch)) subs.set(ch, s.bus.subscribe(internal, (data) => send({ type: 'event', channel: ch, data })));
          send({ type: 'subscribed', channel: ch });
          if (ch.startsWith('book:')) send({ type: 'event', channel: ch, data: s.exchange.depth(ch.slice(5)) });
          return;
        }
        if (msg.op === 'unsubscribe') {
          subs.get(ch)?.();
          subs.delete(ch);
          return send({ type: 'unsubscribed', channel: ch });
        }
        if (msg.op === 'ping') return send({ type: 'pong' });
        send({ type: 'error', error: 'unknown_op' });
      } catch (e) {
        send({ type: 'error', error: e instanceof ApiError ? e.code : 'internal' });
      }
    });
    socket.on('close', () => {
      for (const off of subs.values()) off();
      subs.clear();
    });
  });
}

export type { FastifyReply };
