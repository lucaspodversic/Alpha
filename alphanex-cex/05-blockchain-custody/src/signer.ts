/**
 * EN: Withdrawal signer — the ONLY component that touches a private key. It runs as a separate
 *     process (see signer-server.ts), bound to 127.0.0.1, and enforces its OWN policy even if the
 *     API is compromised:
 *       - HMAC-authenticated requests with a freshness window,
 *       - replay protection by withdrawalId,
 *       - ≥ N distinct approvers, none of them the requester (4-eyes / 2-person rule),
 *       - asset allowlist with per-tx and rolling-daily caps,
 *       - chainId allowlist (testnets/local only by default: 31337 anvil, 11155111 Sepolia).
 *     It does NOT broadcast: it returns a signed raw tx; the API's broadcaster sends it.
 * ES: Firmante de retiros — el ÚNICO componente que toca una clave privada. Corre como proceso
 *     separado (ver signer-server.ts), escuchando en 127.0.0.1, y aplica SU PROPIA política aunque
 *     la API esté comprometida:
 *       - pedidos autenticados con HMAC y ventana de frescura,
 *       - protección anti-replay por withdrawalId,
 *       - ≥ N aprobadores distintos, ninguno el solicitante (regla de 4 ojos / 2 personas),
 *       - lista permitida de activos con topes por tx y diario móvil,
 *       - lista permitida de chainId (solo testnets/local por defecto: 31337 anvil, 11155111 Sepolia).
 *     NO difunde: devuelve una tx firmada en crudo; el difusor de la API la envía.
 */
import { encodeFunctionData, erc20Abi, isAddress, getAddress, keccak256, type Address, type Hex, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyPayload } from './hmac.js';

// ---------------------------------------------------------------------------
// EN: Key providers / ES: Proveedores de clave
// ---------------------------------------------------------------------------

/** EN: Abstraction so prod can plug a KMS/HSM without code changes. / ES: Abstracción para enchufar un KMS/HSM en prod sin cambiar código. */
export interface KeyProvider {
  getAccount(): Promise<LocalAccount>;
}

/**
 * EN: Reads the hot-wallet key from an env var. Acceptable for local/testnet; in production use a KMS.
 *     The key is validated but never logged or returned.
 * ES: Lee la clave de la hot wallet desde una variable de entorno. Aceptable para local/testnet; en
 *     producción usar un KMS. La clave se valida pero nunca se loguea ni se devuelve.
 */
export class EnvKeyProvider implements KeyProvider {
  private account: LocalAccount | null = null;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly varName = 'HOT_WALLET_PRIVATE_KEY') {}
  async getAccount(): Promise<LocalAccount> {
    if (this.account) return this.account;
    const raw = this.env[this.varName];
    if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${this.varName} missing or malformed (expected 0x + 64 hex)`);
    this.account = privateKeyToAccount(raw as Hex);
    return this.account;
  }
}

/**
 * EN: Placeholder for AWS KMS / GCP KMS / HSM. Intentionally not implemented: a real
 *     integration needs the provider SDK and an audited DER→(r,s,v) conversion.
 * ES: Marcador para AWS KMS / GCP KMS / HSM. Intencionalmente sin implementar: una integración
 *     real necesita el SDK del proveedor y una conversión DER→(r,s,v) auditada.
 */
export class KmsKeyProvider implements KeyProvider {
  constructor(readonly keyId: string) {}
  async getAccount(): Promise<LocalAccount> {
    throw new Error(`KMS key provider not configured (keyId=${this.keyId}); see RFC §Custody`);
  }
}

// ---------------------------------------------------------------------------
// EN: Policy / ES: Política
// ---------------------------------------------------------------------------

/** EN: Per-asset policy. / ES: Política por activo. */
export interface AssetPolicy {
  kind: 'native' | 'erc20';
  contract?: Address;
  perTxMax: bigint;
  dailyMax: bigint;
}

export interface SignerPolicy {
  hmacSecret: string;
  allowedChainIds: readonly number[];
  assets: Readonly<Record<string, AssetPolicy>>;
  minApprovals: number;
  /** EN: Max age of a request in ms. / ES: Antigüedad máxima de un pedido en ms. */
  maxSkewMs: number;
  /** EN: Destination denylist (e.g. our own deposit/hot addresses). / ES: Lista de destinos prohibidos. */
  denyTo?: ReadonlySet<string>;
}

/** EN: Testnet/local chain ids. Mainnet (1) is NOT here on purpose. / ES: Chain ids de testnet/local. Mainnet (1) NO está a propósito. */
export const SAFE_CHAIN_IDS = [31337, 11155111] as const;

/**
 * EN: Request body sent by the API. Amounts/fees are decimal strings (base units).
 * ES: Cuerpo del pedido enviado por la API. Montos/fees son strings decimales (unidades base).
 */
export interface SignRequest {
  withdrawalId: string;
  asset: string;
  to: string;
  amount: string;
  chainId: number;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  requestedBy: string;
  approvals: string[];
  timestamp: number;
}

export interface SignResponse {
  withdrawalId: string;
  rawTx: Hex;
  txHash: Hex;
  from: Address;
}

/** EN: Policy rejection with a machine-readable code. / ES: Rechazo de política con código legible por máquina. */
export class PolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class WithdrawalSigner {
  // EN: Replay set and daily spend window (in-memory; a production signer persists these).
  // ES: Conjunto anti-replay y ventana de gasto diario (en memoria; un firmante de producción los persiste).
  private readonly seen = new Set<string>();
  private readonly spent: { asset: string; amount: bigint; at: number }[] = [];

  constructor(private readonly keys: KeyProvider, private readonly policy: SignerPolicy, private readonly now: () => number = Date.now) {
    if (policy.minApprovals < 2) throw new Error('minApprovals must be >= 2 (two-person rule)');
    if (!policy.hmacSecret || policy.hmacSecret.length < 32) throw new Error('hmacSecret must be >= 32 chars');
  }

  /**
   * EN: Validates everything, then signs. Order matters: cheap auth checks first, state changes last.
   * ES: Valida todo y luego firma. El orden importa: controles de auth baratos primero, cambios de estado al final.
   */
  async sign(req: SignRequest, signature: string): Promise<SignResponse> {
    const p = this.policy;
    if (!verifyPayload(p.hmacSecret, req, signature)) throw new PolicyError('bad_hmac', 'invalid request signature');
    if (Math.abs(this.now() - req.timestamp) > p.maxSkewMs) throw new PolicyError('stale', 'request timestamp outside window');
    if (this.seen.has(req.withdrawalId)) throw new PolicyError('replay', 'withdrawal already signed');
    if (!p.allowedChainIds.includes(req.chainId)) throw new PolicyError('chain', `chainId ${req.chainId} not allowed`);
    const ap = p.assets[req.asset];
    if (!ap) throw new PolicyError('asset', `asset ${req.asset} not allowlisted`);
    if (!isAddress(req.to) || /^0x0{40}$/i.test(req.to)) throw new PolicyError('to', 'invalid destination');
    if (p.denyTo?.has(req.to.toLowerCase())) throw new PolicyError('to', 'destination is denylisted');
    // EN: Two-person rule: distinct approvers, requester excluded. / ES: Regla de dos personas: aprobadores distintos, sin el solicitante.
    const approvers = new Set(req.approvals.filter((a) => a !== req.requestedBy));
    if (approvers.size < p.minApprovals) throw new PolicyError('approvals', `need ${p.minApprovals} distinct approvers other than requester`);
    let amount: bigint;
    try {
      amount = BigInt(req.amount);
    } catch {
      throw new PolicyError('amount', 'amount not an integer');
    }
    if (amount <= 0n || !/^\d+$/.test(req.amount)) throw new PolicyError('amount', 'amount must be positive');
    if (amount > ap.perTxMax) throw new PolicyError('per_tx_cap', 'amount exceeds per-transaction cap');
    const since = this.now() - DAY_MS;
    const today = this.spent.filter((s) => s.asset === req.asset && s.at > since).reduce((a, s) => a + s.amount, 0n);
    if (today + amount > ap.dailyMax) throw new PolicyError('daily_cap', 'amount exceeds rolling daily cap');

    // EN: Build the EIP-1559 tx. / ES: Construir la tx EIP-1559.
    const to = getAddress(req.to);
    const base = {
      chainId: req.chainId,
      nonce: req.nonce,
      gas: BigInt(req.gas),
      maxFeePerGas: BigInt(req.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(req.maxPriorityFeePerGas),
      type: 'eip1559' as const,
    };
    const tx =
      ap.kind === 'native'
        ? { ...base, to, value: amount }
        : { ...base, to: ap.contract!, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) };
    const account = await this.keys.getAccount();
    const rawTx = await account.signTransaction!(tx);

    // EN: Record only after a successful signature. / ES: Registrar solo tras una firma exitosa.
    this.seen.add(req.withdrawalId);
    this.spent.push({ asset: req.asset, amount, at: this.now() });
    return { withdrawalId: req.withdrawalId, rawTx, txHash: keccak256(rawTx), from: account.address };
  }
}

/**
 * EN: Builds a policy from env vars (used by signer-server). Caps are in base units.
 *     SIGNER_ASSETS example: "ETH:native::1000000000000000000:5000000000000000000,USDT:erc20:0xabc...:1000000000:5000000000"
 * ES: Construye una política desde variables de entorno (usada por signer-server). Topes en unidades base.
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): SignerPolicy {
  const secret = env.SIGNER_HMAC_SECRET ?? '';
  const chains = (env.SIGNER_ALLOWED_CHAIN_IDS ?? SAFE_CHAIN_IDS.join(','))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  // EN: Testnet/local only in this reference implementation. / ES: Solo testnet/local en esta implementación de referencia.
  const bad = chains.filter((c) => !(SAFE_CHAIN_IDS as readonly number[]).includes(c));
  if (bad.length) throw new Error(`chainIds ${bad.join(',')} refused (only ${SAFE_CHAIN_IDS.join(', ')})`);
  const assets: Record<string, AssetPolicy> = {};
  for (const item of (env.SIGNER_ASSETS ?? '').split(',').filter(Boolean)) {
    const [code, kind, contract, perTx, daily] = item.split(':');
    if (!code || (kind !== 'native' && kind !== 'erc20') || !perTx || !daily) throw new Error(`bad SIGNER_ASSETS item: ${item}`);
    assets[code] = { kind, contract: contract ? (getAddress(contract) as Address) : undefined, perTxMax: BigInt(perTx), dailyMax: BigInt(daily) };
  }
  return { hmacSecret: secret, allowedChainIds: chains, assets, minApprovals: Number(env.SIGNER_MIN_APPROVALS ?? 2), maxSkewMs: 60_000 };
}
