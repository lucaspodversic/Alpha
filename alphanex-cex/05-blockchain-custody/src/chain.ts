/**
 * EN: Chain abstraction used by the deposit watcher and reconciliation. Two implementations:
 *     `ViemChainReader` (real JSON-RPC: anvil or Sepolia) and `MockChain` (tests, reorg simulation).
 * ES: Abstracción de cadena usada por el watcher de depósitos y la conciliación. Dos implementaciones:
 *     `ViemChainReader` (JSON-RPC real: anvil o Sepolia) y `MockChain` (tests, simulación de reorgs).
 */
import { createPublicClient, http, parseAbiItem, erc20Abi, getAddress, type Address, type Hex, type PublicClient } from 'viem';

/** EN: Minimal block header. / ES: Cabecera de bloque mínima. */
export interface BlockHeader {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
}

/**
 * EN: A value transfer INTO one of our addresses. `logIndex` is -1 for native ETH transfers.
 * ES: Una transferencia de valor HACIA una de nuestras direcciones. `logIndex` es -1 para ETH nativo.
 */
export interface IncomingTransfer {
  asset: string;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
  from: Address;
  to: Address;
  amount: bigint;
}

/** EN: Which assets to watch and how. / ES: Qué activos vigilar y cómo. */
export interface WatchedAsset {
  code: string;
  kind: 'native' | 'erc20';
  contract?: Address;
}

/** EN: Read-only chain access. / ES: Acceso de solo lectura a la cadena. */
export interface ChainReader {
  getHeadNumber(): Promise<bigint>;
  /** EN: Header of the canonical block at `n`, or null if it doesn't exist (yet). / ES: Cabecera del bloque canónico `n`, o null si no existe (aún). */
  getHeader(n: bigint): Promise<BlockHeader | null>;
  /** EN: Transfers to `watched` in block `n` (canonical). / ES: Transferencias a `watched` en el bloque `n` (canónico). */
  getIncomingTransfers(n: bigint, watched: ReadonlySet<string>, assets: readonly WatchedAsset[]): Promise<IncomingTransfer[]>;
  /** EN: Balance of `address` in `asset`. / ES: Saldo de `address` en `asset`. */
  getBalance(address: Address, asset: WatchedAsset): Promise<bigint>;
}

// EN: ERC-20 Transfer event signature. / ES: Firma del evento Transfer de ERC-20.
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * EN: JSON-RPC implementation with viem. Works against anvil or a testnet RPC.
 * ES: Implementación JSON-RPC con viem. Funciona contra anvil o un RPC de testnet.
 */
export class ViemChainReader implements ChainReader {
  readonly client: PublicClient;
  constructor(rpcUrl: string, client?: PublicClient) {
    this.client = client ?? createPublicClient({ transport: http(rpcUrl) });
  }

  getHeadNumber(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  async getHeader(n: bigint): Promise<BlockHeader | null> {
    try {
      const b = await this.client.getBlock({ blockNumber: n });
      return { number: b.number!, hash: b.hash!, parentHash: b.parentHash };
    } catch {
      // EN: Block not found ⇒ null. / ES: Bloque inexistente ⇒ null.
      return null;
    }
  }

  async getIncomingTransfers(n: bigint, watched: ReadonlySet<string>, assets: readonly WatchedAsset[]): Promise<IncomingTransfer[]> {
    const out: IncomingTransfer[] = [];
    if (watched.size === 0) return out;
    const block = await this.client.getBlock({ blockNumber: n, includeTransactions: true });
    // EN: Native ETH: scan top-level txs (internal transfers from contracts are NOT detected — documented limitation).
    // ES: ETH nativo: escanear txs de primer nivel (las transferencias internas de contratos NO se detectan — limitación documentada).
    const native = assets.find((a) => a.kind === 'native');
    if (native) {
      for (const tx of block.transactions) {
        if (!tx.to || tx.value === 0n || !watched.has(tx.to.toLowerCase())) continue;
        // EN: A reverted tx moves no value, so check the receipt. / ES: Una tx revertida no mueve valor, se revisa el recibo.
        const receipt = await this.client.getTransactionReceipt({ hash: tx.hash });
        if (receipt.status !== 'success') continue;
        out.push({ asset: native.code, txHash: tx.hash, logIndex: -1, blockNumber: n, blockHash: block.hash!, from: tx.from, to: getAddress(tx.to), amount: tx.value });
      }
    }
    // EN: ERC-20: one getLogs per token for this block, filtered by indexed `to`.
    // ES: ERC-20: un getLogs por token para este bloque, filtrado por `to` indexado.
    const toList = [...watched].map((a) => getAddress(a));
    for (const a of assets) {
      if (a.kind !== 'erc20' || !a.contract) continue;
      const logs = await this.client.getLogs({ address: a.contract, event: TRANSFER_EVENT, args: { to: toList }, blockHash: block.hash! });
      for (const l of logs) {
        if (l.removed) continue;
        out.push({ asset: a.code, txHash: l.transactionHash!, logIndex: l.logIndex!, blockNumber: n, blockHash: l.blockHash!, from: l.args.from!, to: l.args.to!, amount: l.args.value! });
      }
    }
    return out;
  }

  getBalance(address: Address, asset: WatchedAsset): Promise<bigint> {
    if (asset.kind === 'native') return this.client.getBalance({ address });
    return this.client.readContract({ address: asset.contract!, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  }
}
