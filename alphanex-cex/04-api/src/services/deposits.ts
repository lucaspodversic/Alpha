/**
 * EN: Deposit side of custody:
 *       - assigns each user ONE deposit address derived from the xpub (no private key here);
 *       - implements the watcher's DepositSink against Postgres (idempotent by txHash:logIndex);
 *       - persists watcher state in the kv table.
 *     Critical reorg policy (a credited deposit disappeared): NO automatic reversal. The user is
 *     frozen (open orders canceled), the deposit is flagged and an alert is emitted; a human decides
 *     whether to reverse (the user may already have traded/withdrawn the funds).
 * ES: Lado de depósitos de la custodia:
 *       - asigna a cada usuario UNA dirección de depósito derivada de la xpub (sin clave privada aquí);
 *       - implementa el DepositSink del watcher sobre Postgres (idempotente por txHash:logIndex);
 *       - persiste el estado del watcher en la tabla kv.
 *     Política ante reorg crítico (desapareció un depósito acreditado): SIN reversión automática. Se
 *     congela al usuario (se cancelan sus órdenes), se marca el depósito y se emite una alerta; una
 *     persona decide si revertir (el usuario pudo haber operado/retirado los fondos).
 */
import {
  DepositAddressDeriver,
  deserializeState,
  serializeState,
  type DepositRecord,
  type DepositSink,
  type WatcherState,
  type WatcherStore,
} from '@alphanex/custody';
import { formatUnits } from '@alphanex/matching-engine';
import type { Db, ExchangeAccounting } from '@alphanex/ledger';
import { unavailable } from '../errors.js';
import type { EventBus } from '../events.js';
import { big } from '../util.js';
import type { AuditLog } from './audit.js';

export class DepositService {
  private readonly deriver?: DepositAddressDeriver;

  constructor(
    private readonly db: Db,
    private readonly acct: ExchangeAccounting,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    xpub: string | undefined,
    private readonly decimals: Record<string, number>,
    // EN: Called on a critical reorg (freeze + cancel orders). / ES: Se llama en un reorg crítico (congelar + cancelar órdenes).
    private readonly onCritical: (userId: string, reason: string) => Promise<void>,
  ) {
    // EN: Only the xpub (public) lives in the API: it can derive addresses but never spend from them.
    // ES: En la API solo vive el xpub (público): puede derivar direcciones pero nunca gastar desde ellas.
    if (xpub) this.deriver = new DepositAddressDeriver(xpub);
  }

  /**
   * EN: Returns the user's address, creating it on first call. The HD index comes from a DB sequence
   *     so two API replicas can never hand out the same index.
   * ES: Devuelve la dirección del usuario, creándola la primera vez. El índice HD sale de una secuencia
   *     de la BD, así dos réplicas de la API nunca entregan el mismo índice.
   */
  async addressFor(userId: string): Promise<{ address: string; index: number }> {
    const ex = await this.db.query<{ address: string; hd_index: number }>('SELECT address, hd_index FROM deposit_addresses WHERE user_id = $1', [userId]);
    if (ex.rows[0]) return { address: ex.rows[0].address, index: Number(ex.rows[0].hd_index) };
    if (!this.deriver) throw unavailable('deposits_not_configured', 'DEPOSIT_XPUB is not set');
    // EN: A DB sequence guarantees unique HD indexes even with concurrent requests; a lost race just wastes an index.
    // ES: Una secuencia de BD garantiza índices HD únicos aun con pedidos concurrentes; una carrera perdida solo desperdicia un índice.
    const n = await this.db.query<{ i: string }>("SELECT nextval('deposit_hd_index_seq')::text AS i");
    const index = Number(n.rows[0]!.i);
    const address = this.deriver.at(index);
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO deposit_addresses(user_id, address, hd_index) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING', [userId, address, index]);
      await this.audit.append(tx, { actor: userId, action: 'deposit.address_assigned', target: userId, details: { address, index } });
    });
    // EN: Re-read: a concurrent request may have won the race. / ES: Releer: una petición concurrente pudo ganar la carrera.
    const r = await this.db.query<{ address: string; hd_index: number }>('SELECT address, hd_index FROM deposit_addresses WHERE user_id = $1', [userId]);
    return { address: r.rows[0]!.address, index: Number(r.rows[0]!.hd_index) };
  }

  /** EN: All deposit addresses (for reconciliation). / ES: Todas las direcciones de depósito (para conciliación). */
  async allAddresses(): Promise<string[]> {
    const r = await this.db.query<{ address: string }>('SELECT address FROM deposit_addresses ORDER BY hd_index');
    return r.rows.map((x) => x.address);
  }

  /** EN: Deposits of a user. / ES: Depósitos de un usuario. */
  async list(userId: string, limit = 100) {
    const r = await this.db.query<{ id: string; asset: string; amount: string; tx_hash: string; block_number: string; status: string; created_at: Date | string }>(
      `SELECT id, asset, amount::text AS amount, tx_hash, block_number::text AS block_number, status, created_at FROM deposits
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, Math.min(limit, 500)],
    );
    return r.rows.map((d) => ({
      id: d.id,
      asset: d.asset,
      amount: formatUnits(big(d.amount), this.decimals[d.asset] ?? 18),
      txHash: d.tx_hash,
      blockNumber: Number(d.block_number),
      status: d.status,
      at: new Date(d.created_at).toISOString(),
    }));
  }

  /** EN: Ledger-backed sink for DepositWatcher. / ES: Sink respaldado por el ledger para DepositWatcher. */
  sink(): DepositSink {
    return {
      addressBook: async () => {
        const r = await this.db.query<{ address: string; user_id: string }>('SELECT address, user_id FROM deposit_addresses');
        return new Map(r.rows.map((x) => [x.address.toLowerCase(), x.user_id]));
      },
      // EN: Seen but not final: recorded as `pending` so the user sees it, but NOT credited.
      // ES: Visto pero no final: se registra como `pending` para que el usuario lo vea, pero NO se acredita.
      onSeen: async (d) => {
        await this.db.query(
          `INSERT INTO deposits(id, user_id, asset, amount, tx_hash, block_number, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')
           ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number, status = CASE WHEN deposits.status = 'orphaned' THEN 'pending' ELSE deposits.status END, updated_at = now()`,
          [d.id, d.userId, d.asset, d.amount.toString(), d.txHash, d.blockNumber.toString()],
        );
        this.bus.publish(`user:${d.userId}`, { type: 'deposit', id: d.id, status: 'pending' });
      },
      // EN: Reached the confirmation depth: credit user + custody in ONE transaction, idempotent by deposit id.
      // ES: Alcanzó la profundidad de confirmación: acreditar usuario + custodia en UNA transacción, idempotente por id de depósito.
      onConfirmed: async (d) => {
        await this.db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO deposits(id, user_id, asset, amount, tx_hash, block_number, status) VALUES ($1,$2,$3,$4,$5,$6,'credited')
             ON CONFLICT (id) DO UPDATE SET status = 'credited', updated_at = now()`,
            [d.id, d.userId, d.asset, d.amount.toString(), d.txHash, d.blockNumber.toString()],
          );
          // EN: Ledger idempotency key deposit:<id> makes a retry a no-op. / ES: La clave deposit:<id> hace que un reintento no haga nada.
          await this.acct.creditDeposit(tx, { userId: d.userId, asset: d.asset, amount: d.amount, eventId: d.id });
          await this.audit.append(tx, { actor: 'watcher', action: 'deposit.credited', target: d.id, details: { userId: d.userId, asset: d.asset, amount: d.amount, block: d.blockNumber } });
        });
        this.bus.publish(`user:${d.userId}`, { type: 'deposit', id: d.id, status: 'credited' });
      },
      // EN: Reorged out before crediting: nothing to undo, just mark it.
      // ES: Salió por reorg antes de acreditar: no hay nada que deshacer, solo marcarlo.
      onOrphaned: async (d) => {
        await this.db.query(`UPDATE deposits SET status = 'orphaned', updated_at = now() WHERE id = $1 AND status = 'pending'`, [d.id]);
      },
      // EN: Reorged out AFTER crediting: never reverse silently (funds may be traded). Freeze user, alert, let ops decide.
      // ES: Salió por reorg DESPUÉS de acreditar: nunca revertir en silencio (los fondos pueden estar operados). Congelar, alertar y que ops decida.
      onCriticalReorg: async (d: DepositRecord) => {
        await this.db.transaction(async (tx) => {
          await tx.query(`UPDATE deposits SET status = 'reorged_after_credit', updated_at = now() WHERE id = $1`, [d.id]);
          await this.audit.append(tx, { actor: 'watcher', action: 'deposit.critical_reorg', target: d.id, details: { userId: d.userId, asset: d.asset, amount: d.amount } });
        });
        await this.onCritical(d.userId, `critical reorg of credited deposit ${d.id}`);
        this.bus.publish('admin', { type: 'alert', severity: 'critical', message: `credited deposit ${d.id} reorged out`, userId: d.userId });
      },
    };
  }

  /** EN: Watcher state persisted in kv. / ES: Estado del watcher persistido en kv. */
  store(key = 'watcher_state'): WatcherStore {
    return {
      // EN: Watcher cursor + recent block hashes persisted in kv so a restart resumes and still detects reorgs.
      // ES: Cursor del watcher + hashes de bloques recientes guardados en kv para que un reinicio continúe y siga detectando reorgs.
      load: async (): Promise<WatcherState | null> => {
        const r = await this.db.query<{ value: string }>('SELECT value FROM kv WHERE key = $1', [key]);
        return r.rows[0] ? deserializeState(r.rows[0].value) : null;
      },
      save: async (s: WatcherState) => {
        await this.db.query('INSERT INTO kv(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, serializeState(s)]);
      },
    };
  }
}
