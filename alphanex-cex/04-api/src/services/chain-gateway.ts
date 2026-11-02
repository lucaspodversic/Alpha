/**
 * EN: Thin abstraction over "talk to the chain" and "ask the signer", so the withdrawal flow can be
 *     tested with fakes and run against anvil/Sepolia with viem. The API process NEVER holds a
 *     private key: it only gets back an already-signed raw transaction from the signer service.
 * ES: Abstracción delgada sobre "hablar con la cadena" y "pedirle al firmante", para que el flujo de
 *     retiros se pruebe con fakes y corra contra anvil/Sepolia con viem. El proceso de la API NUNCA
 *     tiene una clave privada: solo recibe del servicio firmante una transacción ya firmada.
 */
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { signPayload, type SignRequest, type SignResponse, type WithdrawalSigner } from '@alphanex/custody';

/** EN: Gas parameters for one tx. / ES: Parámetros de gas para una tx. */
export interface TxParams {
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** EN: Receipt summary. / ES: Resumen del recibo. */
export interface TxOutcome {
  status: 'success' | 'reverted';
  gasCostWei: bigint;
  blockNumber: bigint;
}

export interface ChainGateway {
  /** EN: Next nonce + fee estimate for the hot wallet. / ES: Próximo nonce + estimación de fees para la hot wallet. */
  prepare(from: string, kind: 'native' | 'erc20'): Promise<TxParams>;
  /** EN: Broadcasts a signed tx. / ES: Difunde una tx firmada. */
  broadcast(rawTx: Hex): Promise<Hex>;
  /** EN: null while pending. / ES: null mientras esté pendiente. */
  receipt(txHash: Hex): Promise<TxOutcome | null>;
}

export interface SignerClient {
  sign(req: SignRequest): Promise<SignResponse>;
}

/** EN: viem-backed gateway (anvil / Sepolia). / ES: Gateway con viem (anvil / Sepolia). */
export class ViemChainGateway implements ChainGateway {
  private readonly client: PublicClient;
  constructor(rpcUrl: string, pollingInterval = 1000) {
    this.client = createPublicClient({ transport: http(rpcUrl), pollingInterval }) as PublicClient;
  }
  // EN: Uses the `pending` nonce so queued txs are counted; gas is a fixed safe ceiling per asset kind.
  // ES: Usa el nonce `pending` para contar txs en cola; el gas es un techo seguro fijo por tipo de activo.
  async prepare(from: string, kind: 'native' | 'erc20'): Promise<TxParams> {
    const [nonce, fees] = await Promise.all([
      this.client.getTransactionCount({ address: from as Hex, blockTag: 'pending' }),
      this.client.estimateFeesPerGas(),
    ]);
    // EN: Fixed generous gas limits: 21k for ETH, 100k for an ERC-20 transfer. Unused gas is not charged.
    // ES: Límites de gas fijos y holgados: 21k para ETH, 100k para transfer ERC-20. El gas no usado no se cobra.
    return { nonce, gas: kind === 'native' ? 21_000n : 100_000n, maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas! };
  }
  broadcast(rawTx: Hex): Promise<Hex> {
    return this.client.sendRawTransaction({ serializedTransaction: rawTx });
  }
  async receipt(txHash: Hex): Promise<TxOutcome | null> {
    const r = await this.client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    // EN: null = not mined yet (the RPC throws for unknown hashes; we map it to null).
    // ES: null = todavía no minada (el RPC lanza error para hashes desconocidos; lo mapeamos a null).
    if (!r) return null;
    return { status: r.status, gasCostWei: r.gasUsed * r.effectiveGasPrice, blockNumber: r.blockNumber };
  }
}

/** EN: HTTP client for the separate signer service (HMAC-authenticated). / ES: Cliente HTTP del firmante separado (autenticado con HMAC). */
export class HttpSignerClient implements SignerClient {
  constructor(private readonly url: string, private readonly secret: string) {
    // EN: Fail fast on weak secrets: the HMAC is the only thing authenticating API → signer calls.
    // ES: Fallar rápido con secretos débiles: el HMAC es lo único que autentica las llamadas API → firmante.
    if (!secret || secret.length < 32) throw new Error('SIGNER_HMAC_SECRET must be >= 32 chars');
  }
  async sign(req: SignRequest): Promise<SignResponse> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': signPayload(this.secret, req) },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as SignResponse & { error?: string; message?: string };
    // EN: Signer refusals (limits, approvals, chain id) are surfaced verbatim to the admin and the audit trail.
    // ES: Los rechazos del firmante (límites, aprobaciones, chain id) se muestran tal cual al admin y en la auditoría.
    if (!res.ok) throw new Error(`signer refused: ${body.error ?? res.status} ${body.message ?? ''}`.trim());
    return body;
  }
}

/** EN: In-process client (tests only: same HMAC path, no network). / ES: Cliente en proceso (solo tests: mismo HMAC, sin red). */
export class DirectSignerClient implements SignerClient {
  constructor(private readonly signer: WithdrawalSigner, private readonly secret: string) {}
  sign(req: SignRequest): Promise<SignResponse> {
    return this.signer.sign(req, signPayload(this.secret, req));
  }
}

/**
 * EN: Deterministic fake for unit tests: records broadcasts and lets the test decide receipts.
 * ES: Fake determinista para tests unitarios: registra difusiones y deja que el test decida recibos.
 */
export class FakeChainGateway implements ChainGateway {
  nonce = 0;
  readonly sent: Hex[] = [];
  readonly outcomes = new Map<string, TxOutcome>();
  failBroadcast = false;
  async prepare(): Promise<TxParams> {
    return { nonce: this.nonce++, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  }
  async broadcast(rawTx: Hex): Promise<Hex> {
    // EN: Test double: can simulate an RPC outage to exercise the failure path.
    // ES: Doble de prueba: puede simular una caída del RPC para ejercitar el camino de error.
    if (this.failBroadcast) throw new Error('rpc down');
    this.sent.push(rawTx);
    const { keccak256 } = await import('viem');
    return keccak256(rawTx);
  }
  async receipt(txHash: Hex): Promise<TxOutcome | null> {
    return this.outcomes.get(txHash) ?? null;
  }
}
