// EN: Deposit watcher behaviour on a mock chain, including reorgs. / ES: Comportamiento del watcher en una cadena simulada, con reorgs.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Address } from 'viem';
import { MockChain } from '../src/mock-chain.js';
import { DepositWatcher, InMemoryWatcherStore, type DepositRecord, type DepositSink } from '../src/watcher.js';

// EN: Vanity test addresses (no keys behind them, never used on a real network).
// ES: Direcciones de prueba legibles (sin claves detrás, nunca usadas en una red real).
const ALICE = '0x00000000000000000000000000000000000A11CE' as Address;
const BOB = '0x0000000000000000000000000000000000000B0B' as Address;
const STRANGER = '0x000000000000000000000000000000000000beef' as Address;

/** EN: Sink that records calls and is idempotent like the ledger. / ES: Sink que registra llamadas y es idempotente como el ledger. */
class RecordingSink implements DepositSink {
  credited = new Map<string, DepositRecord>();
  creditCalls = 0;
  orphaned: DepositRecord[] = [];
  critical: DepositRecord[] = [];
  async addressBook() {
    return new Map([
      [ALICE.toLowerCase(), 'alice'],
      [BOB.toLowerCase(), 'bob'],
    ]);
  }
  async onConfirmed(d: DepositRecord) {
    this.creditCalls++;
    if (!this.credited.has(d.id)) this.credited.set(d.id, { ...d });
  }
  async onOrphaned(d: DepositRecord) {
    this.orphaned.push({ ...d });
  }
  async onCriticalReorg(d: DepositRecord) {
    this.critical.push({ ...d });
  }
}

// EN: Watched assets: native ETH and an ERC-20 at a fixed mock address, both with 3 confirmations.
// ES: Activos vigilados: ETH nativo y un ERC-20 en una dirección simulada fija, ambos con 3 confirmaciones.
const ASSETS = [
  { code: 'ETH', kind: 'native' as const, confirmations: 3 },
  { code: 'USDT', kind: 'erc20' as const, confirmations: 3 },
];

describe('DepositWatcher', () => {
  let chain: MockChain;
  let sink: RecordingSink;
  let store: InMemoryWatcherStore;
  let w: DepositWatcher;

  beforeEach(() => {
    chain = new MockChain();
    sink = new RecordingSink();
    store = new InMemoryWatcherStore();
    w = new DepositWatcher({ chain, sink, store, assets: ASSETS, startBlock: 1n, window: 16 });
  });

  it('credits only after N confirmations, exactly once / acredita solo tras N confirmaciones, una vez', async () => {
    // EN: The block that contains the transfer counts as confirmation #1.
    // ES: El bloque que contiene la transferencia cuenta como confirmación #1.
    chain.mine([{ asset: 'USDT', to: ALICE, amount: 100n }]);
    await w.poll();
    expect(sink.credited.size).toBe(0); // 1 conf
    chain.mine();
    await w.poll();
    expect(sink.credited.size).toBe(0); // 2 confs
    chain.mine();
    const r = await w.poll();
    expect(r.credited).toBe(1); // 3 confs
    chain.mineEmpty(5);
    await w.poll();
    // EN: More blocks and more polls never call credit again for the same deposit.
    // ES: Más bloques y más polls nunca vuelven a acreditar el mismo depósito.
    expect(sink.creditCalls).toBe(1);
    expect([...sink.credited.values()][0]!.userId).toBe('alice');
  });

  it('ignores unknown addresses and unwatched assets / ignora direcciones desconocidas y activos no vigilados', async () => {
    chain.mine([
      { asset: 'USDT', to: STRANGER, amount: 5n },
      { asset: 'DOGE', to: ALICE, amount: 5n },
    ]);
    chain.mineEmpty(5);
    const r = await w.poll();
    // EN: Transfers to addresses not in our address book, or of assets we do not watch, are invisible.
    // ES: Transferencias a direcciones fuera de nuestra libreta, o de activos no vigilados, son invisibles.
    expect(r.seen).toBe(0);
  });

  it('orphans a pending deposit on reorg / deja huérfano un depósito pendiente ante reorg', async () => {
    chain.mine([{ asset: 'ETH', to: BOB, amount: 7n }]);
    await w.poll();
    // EN: Shallow reorg (1 block) while the deposit is still pending.
    // ES: Reorg superficial (1 bloque) mientras el depósito sigue pendiente.
    chain.reorg(1);
    chain.mine(); // EN: replacement branch without the tx / ES: rama de reemplazo sin la tx
    chain.mine();
    const r = await w.poll();
    expect(r.reorgDepth).toBe(1);
    // EN: Pending deposit disappeared → orphaned, never credited (mining more blocks below changes nothing).
    // ES: El depósito pendiente desapareció → huérfano, nunca acreditado (minar más bloques abajo no cambia nada).
    expect(r.orphaned).toBe(1);
    chain.mineEmpty(5);
    await w.poll();
    expect(sink.credited.size).toBe(0);
  });

  it('re-included tx in new branch is credited once / tx re-incluida en la rama nueva se acredita una vez', async () => {
    chain.mine([{ asset: 'USDT', to: ALICE, amount: 9n }]);
    await w.poll();
    chain.reorg(1);
    chain.mine([{ asset: 'USDT', to: ALICE, amount: 9n }]); // EN: different block hash ⇒ different tx hash in mock / ES: hash distinto
    chain.mineEmpty(3);
    await w.poll();
    expect(sink.credited.size).toBe(1);
    // EN: Old version orphaned, re-included version credited once: no double credit across branches.
    // ES: Versión vieja huérfana, versión re-incluida acreditada una vez: sin doble crédito entre ramas.
    expect(sink.orphaned.length).toBe(1);
  });

  it('raises CRITICAL when a credited deposit is reorged out / alerta CRÍTICA si un depósito acreditado desaparece', async () => {
    chain.mine([{ asset: 'USDT', to: ALICE, amount: 50n }]);
    chain.mineEmpty(3);
    await w.poll();
    expect(sink.credited.size).toBe(1);
    // EN: Reorg deeper than the confirmation depth AFTER crediting → must escalate, not reverse silently.
    // ES: Reorg más profundo que las confirmaciones DESPUÉS de acreditar → debe escalar, no revertir en silencio.
    chain.reorg(4);
    chain.mineEmpty(6);
    const r = await w.poll();
    expect(r.critical).toBe(1);
    expect(sink.critical[0]!.amount).toBe(50n);
  });

  it('resumes from persisted state without double credit / reanuda desde el estado persistido sin doble crédito', async () => {
    chain.mine([{ asset: 'ETH', to: ALICE, amount: 1n }]);
    chain.mineEmpty(1);
    await w.poll();
    // EN: "restart": new watcher instance, same store. / ES: "reinicio": nueva instancia, mismo store.
    // EN: Simulated restart: a new watcher reads the same persisted store and continues where w stopped.
    // ES: Reinicio simulado: un watcher nuevo lee el mismo store persistido y sigue donde w se detuvo.
    const w2 = new DepositWatcher({ chain, sink, store, assets: ASSETS, startBlock: 1n, window: 16 });
    chain.mineEmpty(3);
    await w2.poll();
    await w2.poll();
    expect(sink.creditCalls).toBe(1);
  });

  it('throws on reorg deeper than the window / falla ante reorg más profundo que la ventana', async () => {
    chain.mineEmpty(30);
    await w.poll();
    chain.reorg(25);
    chain.mineEmpty(26);
    // EN: Reorg beyond the hash window cannot be resolved safely → stop and require a human.
    // ES: Un reorg más allá de la ventana de hashes no se puede resolver con seguridad → detenerse y pedir una persona.
    await expect(w.poll()).rejects.toThrow(/deeper than tracking window/);
  });

  it('respects batchSize / respeta batchSize', async () => {
    const small = new DepositWatcher({ chain, sink, store: new InMemoryWatcherStore(), assets: ASSETS, startBlock: 1n, batchSize: 2 });
    chain.mineEmpty(5);
    // EN: batchSize bounds the work per poll (RPC-friendly catch-up).
    // ES: batchSize acota el trabajo por poll (puesta al día amigable con el RPC).
    expect((await small.poll()).scanned).toBe(2);
    expect((await small.poll()).cursor).toBe(4n);
  });
});
