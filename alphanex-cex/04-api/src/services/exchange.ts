/**
 * EN: Spot trading service: glues the in-memory matching engine to the Postgres ledger.
 *
 *     Concurrency model: ONE writer per market (promise mutex). All mutations of a market's book
 *     happen inside its mutex, and every submission runs a single DB transaction:
 *         hold funds → engine.submit → settle trades → persist orders/trades → release leftovers
 *     If anything fails after the engine was mutated, the transaction rolls back and the book is
 *     REBUILT from the database (the DB is the source of truth, the book is a cache).
 *
 *     Hold rules (fees never need extra hold because buyer pays fee in base, seller in quote):
 *       - buy limit  : quote = price × qty
 *       - buy market : quote = exact cost of walking the asks now (engine capped by maxQuote)
 *       - sell       : base  = qty
 *
 * ES: Servicio de trading spot: une el motor de matching en memoria con el ledger en Postgres.
 *
 *     Modelo de concurrencia: UN escritor por mercado (mutex de promesas). Toda mutación del libro
 *     ocurre dentro de su mutex y cada envío corre una única transacción de BD:
 *         retener fondos → engine.submit → liquidar trades → persistir órdenes/trades → liberar sobrantes
 *     Si algo falla después de mutar el motor, la transacción hace rollback y el libro se
 *     RECONSTRUYE desde la base (la BD es la fuente de verdad, el libro es una caché).
 *
 *     Reglas de retención (las comisiones no requieren retención extra porque el comprador paga
 *     en base y el vendedor en quote):
 *       - compra límite  : quote = precio × cantidad
 *       - compra mercado : quote = costo exacto de recorrer los asks ahora (el motor topea con maxQuote)
 *       - venta          : base  = cantidad
 */
import { randomUUID } from 'node:crypto';
import {
  OrderBook,
  OrderValidationError,
  PrecisionError,
  formatUnits,
  parseUnits,
  type MarketSpec,
  type NewOrder,
  type OrderStatus,
  type Side,
  type SubmitResult,
  type TimeInForce,
} from '@alphanex/matching-engine';
import { ExchangeAccounting, InsufficientFundsError, type Db, type Queryable } from '@alphanex/ledger';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { EventBus } from '../events.js';
import { Mutex, big } from '../util.js';
import type { AuditLog } from './audit.js';

/** EN: Order as returned by the API (human-readable strings). / ES: Orden tal como la devuelve la API (strings legibles). */
// EN: Public shape of an order: all amounts are decimal strings already scaled to the asset's decimals.
// ES: Forma pública de una orden: todos los montos son strings decimales ya escalados a los decimales del activo.
export interface OrderView {
  id: string;
  market: string;
  side: Side;
  type: 'limit' | 'market';
  tif: string;
  price: string | null;
  qty: string;
  remaining: string;
  filled: string;
  filledQuote: string;
  status: string;
  reason: string | null;
  clientOrderId: string | null;
  createdAt: string;
}

/** EN: Input of POST /orders. / ES: Entrada de POST /orders. */
export interface PlaceOrderInput {
  market: string;
  side: Side;
  type: 'limit' | 'market';
  tif?: TimeInForce;
  price?: string;
  qty: string;
  clientOrderId?: string;
}

// EN: Per-market runtime state: spec, in-memory book (cache of the DB), its single-writer mutex and the freeze flag.
// ES: Estado de ejecución por mercado: spec, libro en memoria (caché de la BD), su mutex de un solo escritor y el flag de congelado.
interface MarketRuntime {
  spec: MarketSpec;
  book: OrderBook;
  mutex: Mutex;
  frozen: boolean;
}

// EN: Statuses that keep funds locked. / ES: Estados que mantienen fondos bloqueados.
// EN: Statuses in which an order still rests on the book and keeps funds on hold.
// ES: Estados en los que una orden sigue en el libro y mantiene fondos retenidos.
const LIVE = new Set(['open', 'partially_filled']);

/** EN: Serializes a MarketSpec for the markets table. / ES: Serializa un MarketSpec para la tabla markets. */
// EN: bigint fields are stored as strings in JSONB (JSON has no bigint).
// ES: Los campos bigint se guardan como strings en JSONB (JSON no tiene bigint).
export function specToJson(s: MarketSpec): Record<string, string | number> {
  return { ...s, tickSize: s.tickSize.toString(), lotSize: s.lotSize.toString(), minQty: s.minQty.toString(), makerFeeBps: s.makerFeeBps.toString(), takerFeeBps: s.takerFeeBps.toString() };
}
/** EN: Inverse of specToJson. / ES: Inversa de specToJson. */
export function specFromJson(j: Record<string, string | number>): MarketSpec {
  return {
    id: String(j.id),
    base: String(j.base),
    quote: String(j.quote),
    baseDecimals: Number(j.baseDecimals),
    quoteDecimals: Number(j.quoteDecimals),
    tickSize: BigInt(j.tickSize!),
    lotSize: BigInt(j.lotSize!),
    minQty: BigInt(j.minQty!),
    makerFeeBps: BigInt(j.makerFeeBps!),
    takerFeeBps: BigInt(j.takerFeeBps!),
  };
}

export class ExchangeService {
  private readonly markets = new Map<string, MarketRuntime>();
  private readonly acct: ExchangeAccounting;

  constructor(
    private readonly db: Db,
    acct: ExchangeAccounting,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {
    this.acct = acct;
  }

  /** EN: Loads markets and rebuilds every book from open orders. / ES: Carga mercados y reconstruye cada libro desde las órdenes abiertas. */
  async init(): Promise<void> {
    const r = await this.db.query<{ id: string; spec: Record<string, string | number>; frozen: boolean }>('SELECT id, spec, frozen FROM markets ORDER BY id');
    for (const m of r.rows) {
      const spec = specFromJson(typeof m.spec === 'string' ? JSON.parse(m.spec) : m.spec);
      this.markets.set(m.id, { spec, book: await this.loadBook(spec), mutex: new Mutex(), frozen: m.frozen });
    }
  }

  /** EN: Rebuilds a book from the DB. / ES: Reconstruye un libro desde la BD. */
  private async loadBook(spec: MarketSpec, q: Queryable = this.db): Promise<OrderBook> {
    const o = await q.query<{ id: string; user_id: string; side: Side; price: string; qty: string; remaining: string; seq: string }>(
      `SELECT id, user_id, side, price::text AS price, qty::text AS qty, remaining::text AS remaining, seq::text AS seq
       FROM orders WHERE market_id = $1 AND status IN ('open','partially_filled') ORDER BY orders.seq`,
      [spec.id],
    );
    // EN: Restore sequence counters so new trade / order ids never collide with persisted ones.
    // ES: Restaurar contadores de secuencia para que los nuevos ids de trade / orden nunca choquen con los guardados.
    const t = await q.query<{ s: string | null }>('SELECT MAX(seq)::text AS s FROM trades WHERE market_id = $1', [spec.id]);
    const so = await q.query<{ s: string | null }>('SELECT MAX(seq)::text AS s FROM orders WHERE market_id = $1', [spec.id]);
    return OrderBook.restore(spec, {
      marketId: spec.id,
      nextOrderSeq: Number(so.rows[0]?.s ?? 0) + 1,
      nextTradeSeq: Number(t.rows[0]?.s ?? 0) + 1,
      orders: o.rows.map((x) => ({ id: x.id, userId: x.user_id, side: x.side, price: BigInt(x.price), qty: BigInt(x.qty), remaining: BigInt(x.remaining), seq: Number(x.seq) })),
    });
  }

  /** EN: Market lookup or 404. / ES: Busca el mercado o 404. */
  market(id: string): MarketRuntime {
    const m = this.markets.get(id);
    if (!m) throw notFound('unknown_market');
    return m;
  }

  /** EN: Public list. / ES: Lista pública. */
  listMarkets() {
    return [...this.markets.values()].map(({ spec, frozen }) => ({
      id: spec.id,
      base: spec.base,
      quote: spec.quote,
      baseDecimals: spec.baseDecimals,
      quoteDecimals: spec.quoteDecimals,
      tickSize: formatUnits(spec.tickSize, spec.quoteDecimals),
      lotSize: formatUnits(spec.lotSize, spec.baseDecimals),
      minQty: formatUnits(spec.minQty, spec.baseDecimals),
      makerFeeBps: Number(spec.makerFeeBps),
      takerFeeBps: Number(spec.takerFeeBps),
      frozen,
    }));
  }

  /** EN: Aggregated depth in human units. / ES: Profundidad agregada en unidades legibles. */
  depth(marketId: string, levels = 20) {
    const { spec, book } = this.market(marketId);
    const d = book.depth(Math.min(Math.max(levels, 1), 200));
    const fmt = (l: { price: bigint; qty: bigint }) => ({ price: formatUnits(l.price, spec.quoteDecimals), qty: formatUnits(l.qty, spec.baseDecimals) });
    return { market: marketId, bids: d.bids.map(fmt), asks: d.asks.map(fmt) };
  }

  /**
   * EN: Places an order (see file header for the flow). / ES: Coloca una orden (ver encabezado para el flujo).
   */
  async placeOrder(userId: string, input: PlaceOrderInput): Promise<OrderView> {
    const m = this.market(input.market);
    // EN: Everything below runs while holding the market's mutex: no other command can touch this book.
    // ES: Todo lo de abajo corre con el mutex del mercado tomado: ningún otro comando puede tocar este libro.
    return m.mutex.run(async () => {
      if (m.frozen) throw forbidden('market_frozen');
      await this.assertNotFrozen(userId);
      const { spec } = m;
      const order = this.parseOrder(spec, userId, input);
      try {
        // EN: Pure validation (tick, lot, min qty, POST_ONLY crossing) before any money moves.
        // ES: Validación pura (tick, lote, cantidad mínima, POST_ONLY cruzando) antes de mover dinero.
        m.book.validate(order);
      } catch (e) {
        if (e instanceof OrderValidationError) throw badRequest('invalid_order', e.message);
        throw e;
      }
      // EN: Size the hold. / ES: Dimensionar la retención.
      let holdAsset: string;
      let hold: bigint;
      if (order.side === 'sell') {
        holdAsset = spec.base;
        hold = order.qty;
      } else if (order.type === 'limit') {
        holdAsset = spec.quote;
        hold = m.book.quoteAmount(order.price!, order.qty);
      } else {
        holdAsset = spec.quote;
        // EN: Market buy: price the walk through the asks NOW (skipping own orders, as STP would) and cap the
        //     engine with maxQuote so it can never spend more than what we hold.
        // ES: Compra a mercado: calcular AHORA el recorrido por los asks (saltando órdenes propias, como haría STP) y
        //     limitar el motor con maxQuote para que nunca gaste más de lo retenido.
        const q = m.book.quoteMarketBuy(order.qty, userId);
        if (q.fillable === 0n) throw badRequest('no_liquidity');
        hold = q.cost;
        order.maxQuote = q.cost;
      }

      // EN: `submitted` tells the error path whether the in-memory book was mutated and must be rebuilt.
      // ES: `submitted` le indica al camino de error si el libro en memoria se modificó y hay que reconstruirlo.
      let submitted = false;
      let result: SubmitResult;
      try {
        result = await this.db.transaction(async (tx) => {
          try {
            await this.acct.hold(tx, { userId, asset: holdAsset, amount: hold, orderId: order.id });
          } catch (e) {
            if (e instanceof InsufficientFundsError) throw badRequest('insufficient_funds', `insufficient ${holdAsset}`);
            throw e;
          }
          // EN: Matching happens inside the DB transaction: if persisting fails, the ledger rolls back with it.
          // ES: El matching ocurre dentro de la transacción de BD: si falla la persistencia, el ledger hace rollback junto con ella.
          const res = m.book.submit(order);
          submitted = true;
          await this.persistSubmission(tx, m, order, input, res, holdAsset, hold);
          return res;
        });
      } catch (e) {
        // EN: Engine state may be ahead of the DB: rebuild from the DB. / ES: El motor puede estar adelantado a la BD: reconstruir.
        if (submitted) m.book = await this.loadBook(spec);
        if (e instanceof ApiError) throw e;
        // EN: 23505 = unique violation → the same clientOrderId was reused by this user.
        // ES: 23505 = violación de unicidad → el usuario reutilizó el mismo clientOrderId.
        if ((e as { code?: string }).code === '23505') throw conflict('duplicate_client_order_id');
        throw e;
      }
      // EN: Publish only AFTER commit, so subscribers never see trades that could still roll back.
      // ES: Publicar solo DESPUÉS del commit, así los suscriptores nunca ven trades que todavía podrían revertirse.
      this.publishAfter(m, result, userId);
      return (await this.getOrder(order.id))!;
    });
  }

  /** EN: Parses and type-checks user input. / ES: Parsea y valida tipos de la entrada. */
  private parseOrder(spec: MarketSpec, userId: string, i: PlaceOrderInput): NewOrder {
    if (i.side !== 'buy' && i.side !== 'sell') throw badRequest('invalid_side');
    if (i.type !== 'limit' && i.type !== 'market') throw badRequest('invalid_type');
    if (i.tif !== undefined && !['GTC', 'IOC', 'POST_ONLY'].includes(i.tif)) throw badRequest('invalid_tif');
    if (i.clientOrderId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(i.clientOrderId)) throw badRequest('invalid_client_order_id');
    try {
      // EN: Strict decimal parsing: too many decimals or garbage → PrecisionError / SyntaxError → 400.
      // ES: Parseo decimal estricto: demasiados decimales o basura → PrecisionError / SyntaxError → 400.
      const qty = parseUnits(String(i.qty), spec.baseDecimals);
      const price = i.type === 'limit' ? parseUnits(String(i.price ?? ''), spec.quoteDecimals) : undefined;
      if (i.type === 'market' && i.price !== undefined) throw badRequest('invalid_order', 'market orders take no price');
      return { id: randomUUID(), userId, side: i.side, type: i.type, tif: i.tif, price, qty };
    } catch (e) {
      if (e instanceof PrecisionError || e instanceof SyntaxError) throw badRequest('invalid_amount', (e as Error).message);
      throw e;
    }
  }

  /**
   * EN: Writes everything a submission produced, inside the same transaction.
   * ES: Escribe todo lo que produjo un envío, dentro de la misma transacción.
   */
  private async persistSubmission(tx: Queryable, m: MarketRuntime, order: NewOrder, input: PlaceOrderInput, res: SubmitResult, holdAsset: string, hold: bigint): Promise<void> {
    const { spec, book } = m;
    const resting = book.getOrder(order.id);
    // EN: Taker row first (makers' trades reference it). / ES: Primero la fila del taker (los trades la referencian).
    await tx.query(
      `INSERT INTO orders(id, market_id, user_id, client_order_id, side, type, tif, price, qty, remaining, filled, filled_quote, hold_asset, hold_amount, hold_left, status, reason, seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17)`,
      [
        order.id,
        spec.id,
        order.userId,
        input.clientOrderId ?? null,
        order.side,
        order.type,
        order.type === 'market' ? 'IOC' : (order.tif ?? 'GTC'),
        order.price?.toString() ?? null,
        order.qty.toString(),
        res.resting.toString(),
        res.filled.toString(),
        res.filledQuote.toString(),
        holdAsset,
        hold.toString(),
        res.status,
        res.reason ?? null,
        resting?.seq ?? null,
      ],
    );
    // EN: Trades: ledger settlement + trade rows + maker fills. / ES: Trades: liquidación + filas + fills de makers.
    // EN: Settle each trade in the ledger (idempotent by trade id) and accumulate fills per maker order.
    // ES: Liquidar cada trade en el ledger (idempotente por id de trade) y acumular lo ejecutado por orden maker.
    const makerFill = new Map<string, { qty: bigint; quote: bigint }>();
    for (const t of res.trades) {
      const id = `${spec.id}:${t.seq}`;
      await this.acct.settleTrade(tx, { id, base: spec.base, quote: spec.quote, qty: t.qty, quoteQty: t.quoteQty, buyerUserId: t.buyerUserId, sellerUserId: t.sellerUserId, buyerFee: t.buyerFee, sellerFee: t.sellerFee });
      await tx.query(
        `INSERT INTO trades(id, market_id, seq, price, qty, quote_qty, taker_side, maker_order_id, taker_order_id, buyer_user_id, seller_user_id, buyer_fee, seller_fee)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, spec.id, t.seq, t.price.toString(), t.qty.toString(), t.quoteQty.toString(), t.takerSide, t.makerOrderId, t.takerOrderId, t.buyerUserId, t.sellerUserId, t.buyerFee.toString(), t.sellerFee.toString()],
      );
      const f = makerFill.get(t.makerOrderId) ?? { qty: 0n, quote: 0n };
      f.qty += t.qty;
      f.quote += t.quoteQty;
      makerFill.set(t.makerOrderId, f);
    }
    // EN: Update each maker: buy makers consume quote from their hold, sell makers consume base.
    //     A maker that became fully filled releases any leftover hold (rounding-free, but defensive).
    // ES: Actualizar cada maker: los makers compradores consumen quote de su retención, los vendedores consumen base.
    //     Un maker que se completó libera cualquier sobrante retenido (no hay redondeo, pero es defensivo).
    for (const u of res.makerUpdates) {
      const f = makerFill.get(u.orderId) ?? { qty: 0n, quote: 0n };
      const r = await tx.query<{ side: Side; hold_left: string; user_id: string; hold_asset: string }>(
        `UPDATE orders SET remaining = $2, status = $3, filled = filled + $4, filled_quote = filled_quote + $5,
           hold_left = hold_left - (CASE WHEN side = 'buy' THEN $5::numeric ELSE $4::numeric END), updated_at = now()
         WHERE id = $1 RETURNING side, hold_left::text AS hold_left, user_id, hold_asset`,
        [u.orderId, u.remaining.toString(), u.status, f.qty.toString(), f.quote.toString()],
      );
      const row = r.rows[0]!;
      if (!LIVE.has(u.status)) await this.releaseRest(tx, u.orderId, row.user_id, row.hold_asset, big(row.hold_left), 'final');
    }
    // EN: Taker leftover: consumed = quote spent (buy) or base sold (sell).
    // ES: Sobrante del taker: consumido = quote gastado (compra) o base vendido (venta).
    // EN: Taker hold bookkeeping: what is left of the hold after this submission.
    // ES: Contabilidad de la retención del taker: lo que queda de la retención tras este envío.
    const consumed = order.side === 'buy' ? res.filledQuote : res.filled;
    let left = hold - consumed;
    if (!LIVE.has(res.status)) {
      await this.releaseRest(tx, order.id, order.userId, holdAsset, left, 'final');
    } else if (order.side === 'buy') {
      // EN: Price improvement: keep only price × remaining locked. / ES: Mejora de precio: dejar bloqueado solo precio × remanente.
      const need = book.quoteAmount(order.price!, res.resting);
      if (left > need) {
        await this.acct.release(tx, { userId: order.userId, asset: holdAsset, amount: left - need, orderId: order.id, reason: 'price_improvement' });
        left = need;
      }
      await tx.query('UPDATE orders SET hold_left = $2 WHERE id = $1', [order.id, left.toString()]);
    } else {
      await tx.query('UPDATE orders SET hold_left = $2 WHERE id = $1', [order.id, left.toString()]);
    }
  }

  /** EN: Releases what is left of a hold and zeroes hold_left. / ES: Libera lo que queda de una retención y pone hold_left en 0. */
  private async releaseRest(tx: Queryable, orderId: string, userId: string, asset: string, amount: bigint, reason: string): Promise<void> {
    if (amount > 0n) await this.acct.release(tx, { userId, asset, amount, orderId, reason });
    await tx.query('UPDATE orders SET hold_left = 0 WHERE id = $1', [orderId]);
  }

  /** EN: Cancels one order of a user. / ES: Cancela una orden de un usuario. */
  async cancelOrder(userId: string, orderId: string, actor = userId): Promise<OrderView> {
    // EN: Another user's order looks exactly like a missing one (no id probing).
    // ES: La orden de otro usuario se ve igual que una inexistente (sin sondeo de ids).
    const owner = await this.db.query<{ user_id: string; market_id: string }>('SELECT user_id, market_id FROM orders WHERE id = $1', [orderId]);
    if (owner.rows[0]?.user_id !== userId) throw notFound('order_not_found');
    const m = this.market(owner.rows[0].market_id);
    await m.mutex.run(() => this.cancelInside(m, orderId, actor, 'user_cancel'));
    return (await this.getOrder(orderId))!;
  }

  /** EN: Cancel while holding the market mutex. / ES: Cancelar con el mutex del mercado tomado. */
  private async cancelInside(m: MarketRuntime, orderId: string, actor: string, reason: string): Promise<void> {
    // EN: Remove from the book first; if the DB update fails, the book is rebuilt from the DB below.
    // ES: Sacar del libro primero; si falla la actualización en BD, abajo se reconstruye el libro desde la BD.
    const removed = m.book.cancel(orderId);
    if (!removed) throw conflict('order_not_open');
    try {
      await this.db.transaction(async (tx) => {
        const r = await tx.query<{ user_id: string; hold_asset: string; hold_left: string }>(
          `UPDATE orders SET status = 'canceled', reason = $2, updated_at = now() WHERE id = $1 AND status IN ('open','partially_filled')
           RETURNING user_id, hold_asset, hold_left::text AS hold_left`,
          [orderId, reason],
        );
        const row = r.rows[0];
        if (!row) throw conflict('order_not_open');
        await this.releaseRest(tx, orderId, row.user_id, row.hold_asset, big(row.hold_left), 'cancel');
        // EN: Cancels by someone else (admin / system freeze) are audited; self-cancels are not (they are in the order row).
        // ES: Las cancelaciones hechas por otro (admin / congelamiento del sistema) se auditan; las propias no (quedan en la fila de la orden).
        if (actor !== row.user_id) await this.audit.append(tx, { actor, action: 'order.cancel', target: orderId, details: { reason } });
      });
    } catch (e) {
      m.book = await this.loadBook(m.spec);
      throw e;
    }
    this.bus.publish(`book:${m.spec.id}`, this.depth(m.spec.id));
  }

  /** EN: Cancels all open orders of a user (optionally one market). / ES: Cancela todas las órdenes abiertas de un usuario. */
  async cancelAllForUser(userId: string, actor: string, reason: string, marketId?: string): Promise<number> {
    let n = 0;
    for (const m of this.markets.values()) {
      if (marketId && m.spec.id !== marketId) continue;
      n += await m.mutex.run(async () => {
        // EN: Snapshot ids first: canceling while iterating the live book would skip entries.
        // ES: Tomar los ids primero: cancelar mientras se recorre el libro vivo saltearía entradas.
        const ids = m.book.snapshot().orders.filter((o) => o.userId === userId).map((o) => o.id);
        for (const id of ids) await this.cancelInside(m, id, actor, reason);
        return ids.length;
      });
    }
    return n;
  }

  /** EN: Freeze/unfreeze a market (no new orders; cancels still allowed). / ES: Congela/descongela un mercado (sin órdenes nuevas; cancelar sí).*/
  async setMarketFrozen(marketId: string, frozen: boolean, actor: string, reason: string): Promise<void> {
    const m = this.market(marketId);
    await m.mutex.run(async () => {
      await this.db.transaction(async (tx) => {
        await tx.query('UPDATE markets SET frozen = $2 WHERE id = $1', [marketId, frozen]);
        await this.audit.append(tx, { actor, action: frozen ? 'market.freeze' : 'market.unfreeze', target: marketId, details: { reason } });
      });
      // EN: Flip the in-memory flag only after the DB commit succeeded.
      // ES: Cambiar el flag en memoria solo después de que el commit en BD salió bien.
      m.frozen = frozen;
    });
  }

  /** EN: Throws if the user is frozen. / ES: Lanza si el usuario está congelado. */
  private async assertNotFrozen(userId: string): Promise<void> {
    const r = await this.db.query<{ frozen: boolean }>('SELECT frozen FROM users WHERE id = $1', [userId]);
    if (!r.rows[0]) throw notFound('user_not_found');
    if (r.rows[0].frozen) throw forbidden('account_frozen');
  }

  /** EN: Emits WS events after commit. / ES: Emite eventos WS después del commit. */
  private publishAfter(m: MarketRuntime, res: SubmitResult, takerId: string): void {
    const { spec } = m;
    // EN: Fan-out: fresh depth snapshot, one message per trade, and a nudge to every affected user.
    // ES: Fan-out: snapshot de profundidad nuevo, un mensaje por trade y un aviso a cada usuario afectado.
    this.bus.publish(`book:${spec.id}`, this.depth(spec.id));
    for (const t of res.trades) {
      this.bus.publish(`trades:${spec.id}`, {
        id: `${spec.id}:${t.seq}`,
        price: formatUnits(t.price, spec.quoteDecimals),
        qty: formatUnits(t.qty, spec.baseDecimals),
        side: t.takerSide,
        at: new Date().toISOString(),
      });
    }
    const users = new Set([takerId, ...res.makerUpdates.map((u) => u.userId)]);
    for (const u of users) this.bus.publish(`user:${u}`, { type: 'orders_changed', market: spec.id });
  }

  /** EN: Single order view. / ES: Vista de una orden. */
  async getOrder(id: string): Promise<OrderView | null> {
    const r = await this.db.query<OrderRow>(`${ORDER_SELECT} WHERE id = $1`, [id]);
    return r.rows[0] ? this.view(r.rows[0]) : null;
  }

  /** EN: Orders of a user. / ES: Órdenes de un usuario. */
  async listOrders(userId: string, opts: { open?: boolean; market?: string; limit?: number } = {}): Promise<OrderView[]> {
    const r = await this.db.query<OrderRow>(
      `${ORDER_SELECT} WHERE user_id = $1 AND ($2::text IS NULL OR market_id = $2)
       AND (NOT $3::boolean OR status IN ('open','partially_filled')) ORDER BY created_at DESC LIMIT $4`,
      [userId, opts.market ?? null, !!opts.open, Math.min(opts.limit ?? 100, 500)],
    );
    return r.rows.map((x) => this.view(x));
  }

  /** EN: Public recent trades. / ES: Trades recientes públicos. */
  async recentTrades(marketId: string, limit = 50) {
    const { spec } = this.market(marketId);
    const r = await this.db.query<{ id: string; price: string; qty: string; taker_side: Side; created_at: Date | string }>(
      `SELECT id, price::text AS price, qty::text AS qty, taker_side, created_at FROM trades WHERE market_id = $1 ORDER BY seq DESC LIMIT $2`,
      [marketId, Math.min(Math.max(limit, 1), 500)],
    );
    return r.rows.map((t) => ({ id: t.id, price: formatUnits(BigInt(t.price), spec.quoteDecimals), qty: formatUnits(BigInt(t.qty), spec.baseDecimals), side: t.taker_side, at: new Date(t.created_at).toISOString() }));
  }

  /** EN: Trades of a user (both sides). / ES: Trades de un usuario (ambos lados). */
  async userTrades(userId: string, limit = 100) {
    const r = await this.db.query<{ id: string; market_id: string; price: string; qty: string; quote_qty: string; buyer_user_id: string; buyer_fee: string; seller_fee: string; maker_order_id: string; taker_order_id: string; created_at: Date | string }>(
      `SELECT id, market_id, price::text AS price, qty::text AS qty, quote_qty::text AS quote_qty, buyer_user_id, buyer_fee::text AS buyer_fee,
              seller_fee::text AS seller_fee, maker_order_id, taker_order_id, created_at
       FROM trades WHERE buyer_user_id = $1 OR seller_user_id = $1 ORDER BY created_at DESC, seq DESC LIMIT $2`,
      [userId, Math.min(limit, 500)],
    );
    return r.rows.map((t) => {
      const { spec } = this.market(t.market_id);
      // EN: Fee asset follows the fee convention: buyer pays in base, seller pays in quote.
      // ES: El activo de la comisión sigue la convención: el comprador paga en base, el vendedor en quote.
      const isBuyer = t.buyer_user_id === userId;
      return {
        id: t.id,
        market: t.market_id,
        side: isBuyer ? 'buy' : 'sell',
        price: formatUnits(BigInt(t.price), spec.quoteDecimals),
        qty: formatUnits(BigInt(t.qty), spec.baseDecimals),
        quoteQty: formatUnits(BigInt(t.quote_qty), spec.quoteDecimals),
        fee: isBuyer ? formatUnits(BigInt(t.buyer_fee), spec.baseDecimals) : formatUnits(BigInt(t.seller_fee), spec.quoteDecimals),
        feeAsset: isBuyer ? spec.base : spec.quote,
        at: new Date(t.created_at).toISOString(),
      };
    });
  }

  /**
   * EN: OHLCV candles aggregated in SQL by `intervalSec` buckets.
   * ES: Velas OHLCV agregadas en SQL por cubetas de `intervalSec`.
   */
  async candles(marketId: string, intervalSec = 60, limit = 200) {
    const { spec } = this.market(marketId);
    // EN: Only whitelisted intervals (1m, 5m, 15m, 1h, 4h, 1d); anything else falls back to 1m.
    // ES: Solo intervalos permitidos (1m, 5m, 15m, 1h, 4h, 1d); cualquier otro vuelve a 1m.
    const iv = [60, 300, 900, 3600, 14400, 86400].includes(intervalSec) ? intervalSec : 60;
    // EN: NOTE: order by the numeric column (t.bucket), not the text alias, or sorting becomes lexicographic.
    // ES: NOTA: ordenar por la columna numérica (t.bucket), no por el alias de texto, o el orden se vuelve lexicográfico.
    const r = await this.db.query<{ bucket_s: string; open: string; high: string; low: string; close: string; volume: string }>(
      `WITH t AS (
         SELECT floor(extract(epoch FROM created_at) / $2)::bigint * $2 AS bucket, seq, price, qty FROM trades WHERE market_id = $1
       )
       SELECT bucket::text AS bucket_s,
              (array_agg(price ORDER BY seq ASC))[1]::text  AS open,
              MAX(price)::text AS high, MIN(price)::text AS low,
              (array_agg(price ORDER BY seq DESC))[1]::text AS close,
              SUM(qty)::text AS volume
       FROM t GROUP BY bucket ORDER BY t.bucket DESC LIMIT $3`,
      [marketId, iv, Math.min(limit, 1000)],
    );
    const p = (v: string) => formatUnits(BigInt(v), spec.quoteDecimals);
    return r.rows.reverse().map((c) => ({ time: Number(c.bucket_s), open: p(c.open), high: p(c.high), low: p(c.low), close: p(c.close), volume: formatUnits(BigInt(c.volume), spec.baseDecimals) }));
  }

  /** EN: 24h ticker. / ES: Ticker de 24h. */
  async ticker(marketId: string) {
    const { spec, book } = this.market(marketId);
    const r = await this.db.query<{ last: string | null; first: string | null; high: string | null; low: string | null; vol: string | null }>(
      `SELECT (array_agg(price ORDER BY seq DESC))[1]::text AS last, (array_agg(price ORDER BY seq ASC))[1]::text AS first,
              MAX(price)::text AS high, MIN(price)::text AS low, SUM(qty)::text AS vol
       FROM trades WHERE market_id = $1 AND created_at > now() - interval '24 hours'`,
      [marketId],
    );
    const x = r.rows[0]!;
    const f = (v: string | null | bigint) => (v === null ? null : formatUnits(BigInt(v), spec.quoteDecimals));
    return { market: marketId, last: f(x.last), open24h: f(x.first), high24h: f(x.high), low24h: f(x.low), volume24h: x.vol ? formatUnits(BigInt(x.vol), spec.baseDecimals) : '0', bestBid: f(book.bestBid()), bestAsk: f(book.bestAsk()) };
  }

  /**
   * EN: Consistency check engine ↔ DB (used by tests and the admin health endpoint):
   *     every resting order must match a live DB row with the same remaining qty.
   * ES: Control de consistencia motor ↔ BD (lo usan tests y el endpoint de salud admin):
   *     cada orden en el libro debe coincidir con una fila viva con el mismo remanente.
   */
  async checkBooksAgainstDb(): Promise<string[]> {
    const problems: string[] = [];
    for (const m of this.markets.values()) {
      // EN: Compare every resting order in RAM with its DB row (remaining qty) and the total count.
      // ES: Comparar cada orden en RAM con su fila en BD (cantidad restante) y la cantidad total.
      const snap = m.book.snapshot();
      const r = await this.db.query<{ id: string; remaining: string }>(
        `SELECT id, remaining::text AS remaining FROM orders WHERE market_id = $1 AND status IN ('open','partially_filled')`,
        [m.spec.id],
      );
      const db = new Map(r.rows.map((x) => [x.id, BigInt(x.remaining)]));
      for (const o of snap.orders) if (db.get(o.id) !== o.remaining) problems.push(`${m.spec.id}: order ${o.id} mismatch`);
      if (db.size !== snap.orders.length) problems.push(`${m.spec.id}: book has ${snap.orders.length} orders, db has ${db.size}`);
    }
    return problems;
  }

  /**
   * EN: Invariant: for every user and asset, the ledger "locked" bucket equals the sum of
   *     hold_left of that user's live orders. Any drift means funds stuck or double-spendable.
   * ES: Invariante: para cada usuario y activo, el bucket "locked" del ledger es igual a la suma
   *     de hold_left de sus órdenes vivas. Cualquier diferencia = fondos trabados o gastables doble.
   */
  async checkHolds(): Promise<string[]> {
    const r = await this.db.query<{ code: string; ledger: string; orders: string }>(
      // EN: Σ hold_left of live orders per (user, asset) must equal the ledger's `locked` balance.
      // ES: Σ hold_left de órdenes vivas por (usuario, activo) debe igualar el saldo `locked` del ledger.
      `WITH h AS (
         SELECT 'user:' || user_id || ':' || hold_asset || ':locked' AS code, SUM(hold_left) AS s
         FROM orders WHERE status IN ('open','partially_filled') GROUP BY 1
       )
       SELECT COALESCE(a.code, h.code) AS code, COALESCE(a.balance,0)::text AS ledger, COALESCE(h.s,0)::text AS orders
       FROM (SELECT code, balance FROM ledger_accounts WHERE code LIKE 'user:%:locked') a
       FULL OUTER JOIN h ON h.code = a.code
       WHERE COALESCE(a.balance,0) <> COALESCE(h.s,0)`,
    );
    return r.rows.map((x) => `${x.code}: ledger ${x.ledger} != open-order holds ${x.orders}`);
  }

  /** EN: Row → view. / ES: Fila → vista. */
  private view(r: OrderRow): OrderView {
    const { spec } = this.market(r.market_id);
    return {
      id: r.id,
      market: r.market_id,
      side: r.side,
      type: r.type,
      tif: r.tif,
      price: r.price === null ? null : formatUnits(BigInt(r.price), spec.quoteDecimals),
      qty: formatUnits(BigInt(r.qty), spec.baseDecimals),
      remaining: formatUnits(BigInt(r.remaining), spec.baseDecimals),
      filled: formatUnits(BigInt(r.filled), spec.baseDecimals),
      filledQuote: formatUnits(BigInt(r.filled_quote), spec.quoteDecimals),
      status: r.status as OrderStatus,
      reason: r.reason,
      clientOrderId: r.client_order_id,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
}

// EN: Raw DB row (NUMERIC columns cast to text to keep full precision).
// ES: Fila cruda de BD (columnas NUMERIC casteadas a texto para conservar toda la precisión).
interface OrderRow {
  id: string;
  market_id: string;
  side: Side;
  type: 'limit' | 'market';
  tif: string;
  price: string | null;
  qty: string;
  remaining: string;
  filled: string;
  filled_quote: string;
  status: string;
  reason: string | null;
  client_order_id: string | null;
  created_at: Date | string;
}

const ORDER_SELECT = `SELECT id, market_id, side, type, tif, price::text AS price, qty::text AS qty, remaining::text AS remaining,
  filled::text AS filled, filled_quote::text AS filled_quote, status, reason, client_order_id, created_at FROM orders`;
