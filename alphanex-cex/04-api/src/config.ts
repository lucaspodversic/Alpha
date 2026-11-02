/**
 * EN: Configuration from environment variables. Safe defaults: bind to 127.0.0.1, in-memory
 *     PGlite, no chain, dev faucet OFF. Secrets are never defaulted.
 * ES: Configuración desde variables de entorno. Defaults seguros: escuchar en 127.0.0.1, PGlite en
 *     memoria, sin cadena, faucet de dev APAGADO. Los secretos nunca tienen default.
 */
export interface AppConfig {
  host: string;
  port: number;
  corsOrigin: string[];
  sessionTtlMs: number;
  rateLimitPerMinute: number;
  authRateLimitPerMinute: number;
  allowDevFaucet: boolean;
  chainId: number;
  rpcUrl?: string;
  depositXpub?: string;
  hotWalletAddress?: string;
  signerUrl?: string;
  signerHmacSecret?: string;
  /** EN: Contract addresses for ERC-20 assets. / ES: Direcciones de contrato de activos ERC-20. */
  tokenContracts: Record<string, string>;
  confirmations: Record<string, number>;
}

/** EN: Parses env into AppConfig. / ES: Parsea el entorno a AppConfig. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
  const cfg: AppConfig = {
    // EN: Secure defaults: loopback only, local CORS origins.
    // ES: Valores seguros por defecto: solo loopback, orígenes CORS locales.
    host: env.HOST || '127.0.0.1',
    port: num('PORT', 4000),
    corsOrigin: (env.CORS_ORIGIN || 'http://127.0.0.1:3000,http://localhost:3000').split(',').map((s) => s.trim()),
    // EN: Sessions expire after 12h by default; global and (stricter) auth rate limits per IP.
    // ES: Las sesiones expiran a las 12h por defecto; límites de tasa por IP global y (más estricto) de auth.
    sessionTtlMs: num('SESSION_TTL_HOURS', 12) * 3600_000,
    rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 600),
    authRateLimitPerMinute: num('AUTH_RATE_LIMIT_PER_MINUTE', 20),
    // EN: The faucet credits fake money; it is refused when NODE_ENV=production.
    // ES: El faucet acredita dinero ficticio; se rechaza con NODE_ENV=production.
    allowDevFaucet: env.ALLOW_DEV_FAUCET === 'true' && env.NODE_ENV !== 'production',
    // EN: Chain / custody settings: all optional so the API can run offline (trading only).
    // ES: Ajustes de cadena / custodia: todos opcionales para que la API corra offline (solo trading).
    chainId: num('CHAIN_ID', 31337),
    rpcUrl: env.RPC_URL || undefined,
    depositXpub: env.DEPOSIT_XPUB || undefined,
    hotWalletAddress: env.HOT_WALLET_ADDRESS || undefined,
    signerUrl: env.SIGNER_URL || undefined,
    signerHmacSecret: env.SIGNER_HMAC_SECRET || undefined,
    tokenContracts: {
      ...(env.USDT_CONTRACT ? { USDT: env.USDT_CONTRACT } : {}),
      ...(env.ANX_CONTRACT ? { ANX: env.ANX_CONTRACT } : {}),
    },
    // EN: Confirmation depth per asset before crediting a deposit.
    // ES: Profundidad de confirmación por activo antes de acreditar un depósito.
    confirmations: { ETH: num('CONFIRMATIONS_ETH', 12), USDT: num('CONFIRMATIONS_USDT', 12), ANX: num('CONFIRMATIONS_ANX', 12) },
  };
  // EN: Mainnet guard (this codebase targets local/testnet only). / ES: Guardia de mainnet (este código apunta solo a local/testnet).
  // EN: Only local anvil (31337) and Sepolia (11155111) are supported; mainnet needs audits first (see RFC).
  // ES: Solo anvil local (31337) y Sepolia (11155111); mainnet requiere auditorías antes (ver RFC).
  // EN: Hard guard: this reference build only talks to Anvil (31337) or Sepolia (11155111), never mainnet.
  // ES: Guarda estricta: esta versión de referencia solo habla con Anvil (31337) o Sepolia (11155111), nunca mainnet.
  if (![31337, 11155111].includes(cfg.chainId)) throw new Error(`CHAIN_ID=${cfg.chainId} not supported (only 31337 / 11155111)`);
  if (cfg.host === '0.0.0.0' && env.NODE_ENV !== 'production' && env.ALLOW_PUBLIC_BIND !== 'true')
    throw new Error('Refusing to bind 0.0.0.0 in dev; set ALLOW_PUBLIC_BIND=true (e.g. inside Docker)');
  return cfg;
}
