/**
 * EN: Deposit watcher with confirmation counting and reorg handling.
 *
 *     Algorithm (one `poll()`):
 *       1. Reorg check: compare our stored hash for the cursor block with the chain. If it differs,
 *          walk back through our recent-hash window until hashes match (the fork point).
 *          Deposits seen above the fork point are ORPHANED if still pending; if one was already
 *          CREDITED we raise a CRITICAL alert (the confirmation depth was too shallow).
 *       2. Scan new blocks one by one (bounded batch), checking parentHash continuity, and record
 *          incoming transfers as PENDING deposits.
 *       3. Credit pending deposits whose confirmations (head - block + 1) reach the asset's
 *          threshold, re-checking that their block hash is still canonical.
 *
 *     Exactly-once crediting: every deposit has a stable id `txHash:logIndex`; the sink must be
 *     idempotent on it (the ledger uses it as idempotency key), so a crash between "credit" and
 *     "save state" can never double-credit.
 *
 * ES: Watcher de depósitos con conteo de confirmaciones y manejo de reorgs.
 *
 *     Algoritmo (un `poll()`):
 *       1. Chequeo de reorg: comparar nuestro hash guardado del bloque cursor con la cadena. Si
 *          difiere, retroceder por la ventana de hashes recientes hasta que coincidan (punto de fork).
 *          Los depósitos vistos por encima del fork quedan HUÉRFANOS si seguían pendientes; si alguno
 *          ya estaba ACREDITADO se levanta una alerta CRÍTICA (la profundidad de confirmación fue corta).
 *       2. Escanear bloques nuevos uno a uno (lote acotado), verificando continuidad de parentHash, y
 *          registrar las transferencias entrantes como depósitos PENDIENTES.
 *       3. Acreditar los pendientes cuyas confirmaciones (head - bloque + 1) alcanzan el umbral del
 *          activo, re-verificando que el hash de su bloque sigue siendo canónico.
 *
 *     Acreditación exactamente-una-vez: cada depósito tiene id estable `txHash:logIndex`; el sink
 *     debe ser idempotente sobre él (el ledger lo usa como clave de idempotencia), así un crash entre
 *     "acreditar" y "guardar estado" nunca acredita dos veces.
 */
import type { Hex } from 'viem';
import type { ChainReader, IncomingTransfer, WatchedAsset } from './chain.js';

/** EN: Deposit lifecycle. / ES: Ciclo de vida del depósito. */
export type DepositStatus = 'pending' | 'credited' | 'orphaned';

/** EN: A tracked deposit. / ES: Un depósito seguido. */
export interface DepositRecord extends IncomingTransfer {
  id: string;
  userId: string;
  status: DepositStatus;
}

/** EN: Persisted watcher state (JSON-serializable via `serializeState`). / ES: Estado persistido del watcher. */
export interface WatcherState {
  cursor: bigint | null;
  recent: { number: bigint; hash: Hex }[];
  deposits: Record<string, DepositRecord>;
}

/** EN: Where state lives (memory in tests, a DB row in the API). / ES: Dónde vive el estado (memoria en tests, una fila de BD en la API). */
export interface WatcherStore {
  load(): Promise<WatcherState | null>;
  save(state: WatcherState): Promise<void>;
}

/** EN: Side effects of the watcher. All must be idempotent by deposit id. / ES: Efectos del watcher. Todos idempotentes por id. */
export interface DepositSink {
  /** EN: Map lower-case address → userId for all deposit addresses. / ES: Mapa dirección en minúsculas → userId. */
  addressBook(): Promise<ReadonlyMap<string, string>>;
  onSeen?(d: DepositRecord): Promise<void>;
  onConfirmed(d: DepositRecord): Promise<void>;
  onOrphaned?(d: DepositRecord): Promise<void>;
  onCriticalReorg(d: DepositRecord): Promise<void>;
}

export interface WatcherOptions {
  chain: ChainReader;
  sink: DepositSink;
  store: WatcherStore;
  assets: readonly (WatchedAsset & { confirmations: number })[];
  /** EN: First block to scan when there is no state. / ES: Primer bloque a escanear sin estado previo. */
  startBlock?: bigint;
  /** EN: Max blocks processed per poll. / ES: Máximo de bloques por poll. */
  batchSize?: number;
  /** EN: How many recent hashes to keep (must exceed max confirmations). / ES: Cuántos hashes recientes guardar (debe superar las confirmaciones máximas). */
  window?: number;
}

/** EN: Summary of a poll, useful for logs/metrics. / ES: Resumen de un poll, útil para logs/métricas. */
export interface PollResult {
  head: bigint;
  cursor: bigint | null;
  scanned: number;
  seen: number;
  credited: number;
  orphaned: number;
  critical: number;
  reorgDepth: number;
}

/** EN: In-memory store. / ES: Store en memoria. */
export class InMemoryWatcherStore implements WatcherStore {
  private snapshot: string | null = null;
  async load(): Promise<WatcherState | null> {
    return this.snapshot ? deserializeState(this.snapshot) : null;
  }
  async save(state: WatcherState): Promise<void> {
    this.snapshot = serializeState(state);
  }
}

/** EN: bigint-safe JSON. / ES: JSON compatible con bigint. */
export function serializeState(s: WatcherState): string {
  return JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v));
}
export function deserializeState(json: string): WatcherState {
  return JSON.parse(json, (_k, v) => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v)) as WatcherState;
}

export class DepositWatcher {
  private readonly batchSize: number;
  private readonly window: number;
  private readonly confs: Map<string, number>;
  private state: WatcherState | null = null;

  constructor(private readonly opts: WatcherOptions) {
    this.batchSize = opts.batchSize ?? 100;
    const maxConf = Math.max(1, ...opts.assets.map((a) => a.confirmations));
    this.window = Math.max(opts.window ?? 128, maxConf + 2);
    this.confs = new Map(opts.assets.map((a) => [a.code, Math.max(1, a.confirmations)]));
  }

  /** EN: Current state (for inspection/tests). / ES: Estado actual (para inspección/tests). */
  async getState(): Promise<WatcherState> {
    if (!this.state) this.state = (await this.opts.store.load()) ?? { cursor: null, recent: [], deposits: {} };
    return this.state;
  }

  /** EN: Runs one polling iteration. / ES: Ejecuta una iteración de polling. */
  async poll(): Promise<PollResult> {
    const st = await this.getState();
    const { chain, sink } = this.opts;
    const res: PollResult = { head: 0n, cursor: st.cursor, scanned: 0, seen: 0, credited: 0, orphaned: 0, critical: 0, reorgDepth: 0 };
    const head = await chain.getHeadNumber();
    res.head = head;

    // EN: First run: anchor on the block BEFORE startBlock so a reorg of the very first scanned
    //     blocks still finds a common ancestor in our window.
    // ES: Primera corrida: anclar en el bloque ANTERIOR a startBlock para que un reorg de los
    //     primeros bloques escaneados igual encuentre un ancestro común en la ventana.
    if (st.cursor === null) {
      const start = this.opts.startBlock ?? head;
      if (start > 0n) {
        const anchor = await chain.getHeader(start - 1n);
        if (anchor) {
          st.cursor = anchor.number;
          st.recent = [{ number: anchor.number, hash: anchor.hash }];
        }
      }
    }

    // ---- 1. reorg detection / detección de reorg ----
    if (st.cursor !== null && st.recent.length > 0) {
      const fork = await this.findForkPoint(st);
      if (fork !== st.cursor) {
        res.reorgDepth = Number(st.cursor - fork);
        await this.rewind(st, fork, res);
      }
    }

    // ---- 2. scan new blocks / escanear bloques nuevos ----
    const book = await sink.addressBook();
    const watched = new Set(book.keys());
    let next = st.cursor === null ? (this.opts.startBlock ?? head) : st.cursor + 1n;
    let budget = this.batchSize;
    while (next <= head && budget-- > 0) {
      const header = await chain.getHeader(next);
      if (!header) break;
      const prev = st.recent[st.recent.length - 1];
      // EN: Parent mismatch mid-scan ⇒ a reorg happened while scanning; stop, next poll rewinds.
      // ES: Parent no coincide a mitad del escaneo ⇒ hubo reorg durante el escaneo; parar, el próximo poll retrocede.
      if (prev && prev.number === next - 1n && prev.hash !== header.parentHash) break;
      const transfers = await chain.getIncomingTransfers(next, watched, this.opts.assets);
      for (const t of transfers) {
        const id = depositId(t);
        const userId = book.get(t.to.toLowerCase());
        if (!userId || st.deposits[id]) continue;
        const rec: DepositRecord = { ...t, id, userId, status: 'pending' };
        st.deposits[id] = rec;
        res.seen++;
        await sink.onSeen?.(rec);
      }
      st.recent.push({ number: header.number, hash: header.hash });
      if (st.recent.length > this.window) st.recent.splice(0, st.recent.length - this.window);
      st.cursor = next;
      res.scanned++;
      next++;
    }

    // ---- 3. confirmations / confirmaciones ----
    for (const d of Object.values(st.deposits)) {
      if (d.status !== 'pending') continue;
      const need = BigInt(this.confs.get(d.asset) ?? 1);
      if (head - d.blockNumber + 1n < need) continue;
      // EN: Only credit what we've scanned AND is still canonical. / ES: Solo acreditar lo escaneado Y aún canónico.
      if (st.cursor === null || d.blockNumber > st.cursor) continue;
      const h = await chain.getHeader(d.blockNumber);
      if (!h || h.hash !== d.blockHash) continue; // EN: next poll will rewind / ES: el próximo poll retrocede
      await sink.onConfirmed(d);
      d.status = 'credited';
      res.credited++;
    }

    // EN: Prune settled deposits far below the window to keep state small.
    // ES: Podar depósitos asentados muy por debajo de la ventana para mantener el estado chico.
    const floor = st.recent[0]?.number ?? 0n;
    for (const [id, d] of Object.entries(st.deposits)) if (d.status !== 'pending' && d.blockNumber < floor) delete st.deposits[id];

    await this.opts.store.save(st);
    res.cursor = st.cursor;
    return res;
  }

  /**
   * EN: Walks back through stored hashes to the highest block still canonical.
   * ES: Retrocede por los hashes guardados hasta el bloque más alto que sigue siendo canónico.
   */
  private async findForkPoint(st: WatcherState): Promise<bigint> {
    for (let i = st.recent.length - 1; i >= 0; i--) {
      const r = st.recent[i]!;
      const h = await this.opts.chain.getHeader(r.number);
      if (h && h.hash === r.hash) return r.number;
    }
    // EN: Reorg deeper than our window: unrecoverable automatically. / ES: Reorg más profundo que la ventana: no recuperable automáticamente.
    throw new Error(`reorg deeper than tracking window (${this.window} blocks); manual intervention required`);
  }

  /** EN: Rolls state back to `fork`. / ES: Revierte el estado hasta `fork`. */
  private async rewind(st: WatcherState, fork: bigint, res: PollResult): Promise<void> {
    st.recent = st.recent.filter((r) => r.number <= fork);
    st.cursor = fork;
    for (const d of Object.values(st.deposits)) {
      if (d.blockNumber <= fork || d.status === 'orphaned') continue;
      if (d.status === 'pending') {
        d.status = 'orphaned';
        res.orphaned++;
        await this.opts.sink.onOrphaned?.(d);
      } else if (d.status === 'credited') {
        // EN: Already credited and now gone: page a human; the API also freezes the user.
        // ES: Ya acreditado y ahora desaparecido: avisar a un humano; la API además congela al usuario.
        res.critical++;
        await this.opts.sink.onCriticalReorg(d);
        d.status = 'orphaned';
      }
    }
    // EN: Orphaned deposits are forgotten so that, if the same tx is re-included in the new branch,
    //     it is seen again (new blockHash) and confirmed normally under the same id.
    // ES: Los huérfanos se olvidan para que, si la misma tx se re-incluye en la rama nueva, se vea de
    //     nuevo (nuevo blockHash) y se confirme normalmente bajo el mismo id.
    for (const [id, d] of Object.entries(st.deposits)) if (d.status === 'orphaned' && d.blockNumber > fork) delete st.deposits[id];
  }
}

/** EN: Stable deposit id. / ES: Id estable del depósito. */
export function depositId(t: Pick<IncomingTransfer, 'txHash' | 'logIndex'>): string {
  return `${t.txHash.toLowerCase()}:${t.logIndex < 0 ? 'native' : t.logIndex}`;
}
