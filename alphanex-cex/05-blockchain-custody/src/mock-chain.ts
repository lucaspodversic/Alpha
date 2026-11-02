/**
 * EN: In-memory chain for deterministic tests. Supports mining blocks with transfers and
 *     REORGS (replace the last k blocks with a different branch).
 * ES: Cadena en memoria para tests deterministas. Permite minar bloques con transferencias y
 *     REORGS (reemplazar los últimos k bloques por otra rama).
 */
import { keccak256, toHex, getAddress, type Address, type Hex } from 'viem';
import type { BlockHeader, ChainReader, IncomingTransfer, WatchedAsset } from './chain.js';

/** EN: A transfer to put in a mock block. / ES: Una transferencia para poner en un bloque simulado. */
export interface MockTransfer {
  asset: string;
  to: Address;
  amount: bigint;
  from?: Address;
}

interface MockBlock extends BlockHeader {
  transfers: IncomingTransfer[];
}

export class MockChain implements ChainReader {
  private blocks: MockBlock[] = [];
  // EN: Salt makes hashes of a new branch differ from the old one. / ES: La sal hace que los hashes de una rama nueva difieran de la vieja.
  private salt = 0;
  // EN: Simulated balances per asset+address (only increase via transfers). / ES: Saldos simulados por activo+dirección.
  private balances = new Map<string, bigint>();

  constructor() {
    // EN: Genesis block 0. / ES: Bloque génesis 0.
    this.blocks.push({ number: 0n, hash: keccak256(toHex('genesis')), parentHash: ('0x' + '00'.repeat(32)) as Hex, transfers: [] });
  }

  /** EN: Mines one block with optional transfers; returns its number. / ES: Mina un bloque con transferencias opcionales; devuelve su número. */
  mine(transfers: MockTransfer[] = []): bigint {
    const parent = this.blocks[this.blocks.length - 1]!;
    const number = parent.number + 1n;
    const hash = keccak256(toHex(`block:${number}:${this.salt}:${parent.hash}`));
    const txs: IncomingTransfer[] = transfers.map((t, i) => {
      const key = `${t.asset}:${t.to.toLowerCase()}`;
      this.balances.set(key, (this.balances.get(key) ?? 0n) + t.amount);
      return {
        asset: t.asset,
        txHash: keccak256(toHex(`tx:${hash}:${i}`)),
        logIndex: i,
        blockNumber: number,
        blockHash: hash,
        from: t.from ?? getAddress('0x000000000000000000000000000000000000dEaD'),
        to: getAddress(t.to),
        amount: t.amount,
      };
    });
    this.blocks.push({ number, hash, parentHash: parent.hash, transfers: txs });
    return number;
  }

  /** EN: Mines `n` empty blocks. / ES: Mina `n` bloques vacíos. */
  mineEmpty(n: number): void {
    for (let i = 0; i < n; i++) this.mine();
  }

  /**
   * EN: Drops the last `depth` blocks (reverting their balance effects); the caller then mines a new branch.
   * ES: Descarta los últimos `depth` bloques (revirtiendo sus efectos en saldos); luego el llamador mina una rama nueva.
   */
  reorg(depth: number): void {
    if (depth >= this.blocks.length) throw new Error('cannot reorg genesis');
    const dropped = this.blocks.splice(this.blocks.length - depth, depth);
    for (const b of dropped) for (const t of b.transfers) {
      const key = `${t.asset}:${t.to.toLowerCase()}`;
      this.balances.set(key, (this.balances.get(key) ?? 0n) - t.amount);
    }
    this.salt++;
  }

  /** EN: Test helper to set a balance directly (e.g. hot wallet funding). / ES: Helper para fijar un saldo directamente. */
  setBalance(asset: string, address: Address, amount: bigint): void {
    this.balances.set(`${asset}:${address.toLowerCase()}`, amount);
  }

  async getHeadNumber(): Promise<bigint> {
    return this.blocks[this.blocks.length - 1]!.number;
  }

  async getHeader(n: bigint): Promise<BlockHeader | null> {
    const b = this.blocks[Number(n)];
    return b ? { number: b.number, hash: b.hash, parentHash: b.parentHash } : null;
  }

  async getIncomingTransfers(n: bigint, watched: ReadonlySet<string>, assets: readonly WatchedAsset[]): Promise<IncomingTransfer[]> {
    const b = this.blocks[Number(n)];
    if (!b) return [];
    const codes = new Set(assets.map((a) => a.code));
    return b.transfers.filter((t) => watched.has(t.to.toLowerCase()) && codes.has(t.asset));
  }

  async getBalance(address: Address, asset: WatchedAsset): Promise<bigint> {
    return this.balances.get(`${asset.code}:${address.toLowerCase()}`) ?? 0n;
  }
}
