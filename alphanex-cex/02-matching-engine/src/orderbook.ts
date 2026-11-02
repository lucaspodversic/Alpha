/**
 * EN: Price-time priority limit order book for ONE market.
 *     Design choices:
 *       - Single writer: callers must serialise calls per market (the API uses a per-market queue).
 *       - Execution price is always the maker's price.
 *       - Self-trade prevention (STP): "cancel taker remainder" (expire taker).
 *       - All math is bigint; quote amounts are exact thanks to `validateMarketSpec`.
 * ES: Libro de órdenes con prioridad precio-tiempo para UN mercado.
 *     Decisiones de diseño:
 *       - Un solo escritor: quien llama debe serializar por mercado (la API usa una cola por mercado).
 *       - El precio de ejecución es siempre el del maker.
 *       - Prevención de auto-trade (STP): "cancelar el remanente del taker".
 *       - Toda la matemática es bigint; los montos quote son exactos gracias a `validateMarketSpec`.
 */
import { feeFor, minBig } from './fixed.js';
import type {
  DepthLevel,
  MakerUpdate,
  MarketSpec,
  NewOrder,
  RestingOrder,
  Side,
  SubmitResult,
  Trade,
} from './types.js';

/**
 * EN: Error raised for invalid orders or market configuration (caller bug or bad input).
 * ES: Error para órdenes o configuración de mercado inválidas (bug del llamador o entrada mala).
 */
export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderValidationError';
  }
}

/**
 * EN: Validates a market spec. The key rule: tickSize * lotSize must be divisible by
 *     10^baseDecimals so that price * qty / 10^baseDecimals is ALWAYS an exact integer.
 * ES: Valida la especificación de un mercado. Regla clave: tickSize * lotSize debe ser divisible
 *     por 10^baseDecimals para que precio * cantidad / 10^baseDecimals sea SIEMPRE un entero exacto.
 */
export function validateMarketSpec(spec: MarketSpec): void {
  if (spec.tickSize <= 0n || spec.lotSize <= 0n) {
    throw new OrderValidationError('tickSize and lotSize must be > 0');
  }
  if (spec.minQty < spec.lotSize || spec.minQty % spec.lotSize !== 0n) {
    throw new OrderValidationError('minQty must be a positive multiple of lotSize');
  }
  const unit = 10n ** BigInt(spec.baseDecimals);
  if ((spec.tickSize * spec.lotSize) % unit !== 0n) {
    throw new OrderValidationError('tickSize * lotSize must be divisible by 10^baseDecimals');
  }
  if (spec.makerFeeBps < 0n || spec.takerFeeBps < 0n || spec.takerFeeBps > 1000n || spec.makerFeeBps > 1000n) {
    throw new OrderValidationError('fees must be between 0 and 1000 bps');
  }
}

/**
 * EN: One price level: FIFO queue of resting orders at the same price.
 * ES: Un nivel de precio: cola FIFO de órdenes en el mismo precio.
 */
interface Level {
  price: bigint;
  orders: RestingOrder[];
  // EN: Sum of `remaining` of all orders in the level (kept incrementally).
  // ES: Suma de `remaining` de todas las órdenes del nivel (se mantiene incrementalmente).
  total: bigint;
}

/**
 * EN: Serializable snapshot used for crash recovery / rebuilding from the database.
 * ES: Snapshot serializable para recuperación ante caídas / reconstrucción desde la base.
 */
export interface BookSnapshot {
  marketId: string;
  nextOrderSeq: number;
  nextTradeSeq: number;
  orders: RestingOrder[];
}

export class OrderBook {
  // EN: Price → level, one map per side. / ES: Precio → nivel, un mapa por lado.
  private readonly bidLevels = new Map<bigint, Level>();
  private readonly askLevels = new Map<bigint, Level>();
  // EN: Sorted prices: bids descending (best first), asks ascending (best first).
  // ES: Precios ordenados: bids descendente (mejor primero), asks ascendente (mejor primero).
  private readonly bidPrices: bigint[] = [];
  private readonly askPrices: bigint[] = [];
  // EN: Order id → resting order, for O(1) lookup on cancel.
  // ES: Id de orden → orden en libro, para búsqueda O(1) al cancelar.
  private readonly index = new Map<string, RestingOrder>();
  // EN: Sequences give deterministic time priority and trade ids.
  // ES: Las secuencias dan prioridad temporal determinista e ids de trades.
  private orderSeq = 1;
  private tradeSeq = 1;
  // EN: 10^baseDecimals cached. / ES: 10^baseDecimals cacheado.
  private readonly unit: bigint;

  constructor(public readonly spec: MarketSpec) {
    validateMarketSpec(spec);
    this.unit = 10n ** BigInt(spec.baseDecimals);
  }

  // ---------------------------------------------------------------------------
  // EN: Queries / ES: Consultas
  // ---------------------------------------------------------------------------

  /** EN: Best bid price or null. / ES: Mejor precio de compra o null. */
  bestBid(): bigint | null {
    return this.bidPrices[0] ?? null;
  }

  /** EN: Best ask price or null. / ES: Mejor precio de venta o null. */
  bestAsk(): bigint | null {
    return this.askPrices[0] ?? null;
  }

  /** EN: Looks up a resting order. / ES: Busca una orden en el libro. */
  getOrder(id: string): RestingOrder | undefined {
    const o = this.index.get(id);
    // EN: Return a copy so callers cannot mutate engine state.
    // ES: Devolvemos copia para que nadie mute el estado del motor.
    return o ? { ...o } : undefined;
  }

  /** EN: Number of resting orders. / ES: Cantidad de órdenes en el libro. */
  size(): number {
    return this.index.size;
  }

  /**
   * EN: Aggregated depth (top `levels` per side) for market data.
   * ES: Profundidad agregada (primeros `levels` por lado) para market data.
   */
  depth(levels = 20): { bids: DepthLevel[]; asks: DepthLevel[] } {
    const agg = (prices: bigint[], map: Map<bigint, Level>): DepthLevel[] =>
      prices.slice(0, levels).map((p) => {
        const l = map.get(p)!;
        return { price: p, qty: l.total, orders: l.orders.length };
      });
    return { bids: agg(this.bidPrices, this.bidLevels), asks: agg(this.askPrices, this.askLevels) };
  }

  /**
   * EN: Exact quote cost of market-buying `qty` right now (walks the asks), plus how much
   *     quantity is actually available. Used by the API to size the ledger hold BEFORE matching.
   *     `excludeUserId` skips the user's own asks (they would be prevented by STP anyway).
   * ES: Costo quote exacto de comprar a mercado `qty` ahora (recorre los asks) y cuánta cantidad
   *     hay realmente. La API lo usa para dimensionar la retención del ledger ANTES del matching.
   *     `excludeUserId` ignora asks del propio usuario (STP los evitaría igual).
   */
  quoteMarketBuy(qty: bigint, excludeUserId?: string): { fillable: bigint; cost: bigint } {
    let left = qty;
    let cost = 0n;
    outer: for (const price of this.askPrices) {
      const level = this.askLevels.get(price)!;
      for (const o of level.orders) {
        // EN: STP stops matching at the first own order, so stop estimating there too.
        // ES: STP corta el matching en la primera orden propia, así que cortamos acá también.
        if (excludeUserId !== undefined && o.userId === excludeUserId) break outer;
        const take = minBig(left, o.remaining);
        cost += (price * take) / this.unit;
        left -= take;
        if (left === 0n) break outer;
      }
    }
    return { fillable: qty - left, cost };
  }

  /**
   * EN: Exact quote amount for `qty` at `price` (validated to be integral by the spec rule).
   * ES: Monto quote exacto para `qty` a `price` (entero garantizado por la regla del spec).
   */
  quoteAmount(price: bigint, qty: bigint): bigint {
    return (price * qty) / this.unit;
  }

  // ---------------------------------------------------------------------------
  // EN: Commands / ES: Comandos
  // ---------------------------------------------------------------------------

  /**
   * EN: Validates an incoming order against tick/lot/min rules. Throws on violation.
   * ES: Valida una orden entrante contra reglas de tick/lote/mínimo. Lanza si no cumple.
   */
  validate(order: NewOrder): void {
    const s = this.spec;
    if (!order.id || !order.userId) throw new OrderValidationError('id and userId are required');
    if (this.index.has(order.id)) throw new OrderValidationError(`duplicate order id ${order.id}`);
    if (order.side !== 'buy' && order.side !== 'sell') throw new OrderValidationError('invalid side');
    if (order.qty < s.minQty) throw new OrderValidationError('qty below minQty');
    if (order.qty % s.lotSize !== 0n) throw new OrderValidationError('qty not a multiple of lotSize');
    if (order.type === 'limit') {
      if (order.price === undefined || order.price <= 0n) throw new OrderValidationError('limit order needs price > 0');
      if (order.price % s.tickSize !== 0n) throw new OrderValidationError('price not a multiple of tickSize');
    } else if (order.type === 'market') {
      if (order.price !== undefined) throw new OrderValidationError('market order must not have a price');
      if (order.tif === 'POST_ONLY') throw new OrderValidationError('market order cannot be POST_ONLY');
    } else {
      throw new OrderValidationError('invalid order type');
    }
    if (order.maxQuote !== undefined && order.maxQuote < 0n) throw new OrderValidationError('maxQuote must be >= 0');
  }

  /**
   * EN: Submits an order: matches against the opposite side, then rests the remainder
   *     (GTC limit) or cancels it (IOC / market / STP).
   * ES: Envía una orden: cruza contra el lado opuesto y luego deja el remanente en el libro
   *     (límite GTC) o lo cancela (IOC / mercado / STP).
   */
  submit(order: NewOrder): SubmitResult {
    this.validate(order);
    const tif = order.type === 'market' ? 'IOC' : (order.tif ?? 'GTC');
    const trades: Trade[] = [];
    const makerUpdates: MakerUpdate[] = [];

    // EN: POST_ONLY: reject if the order would cross the spread.
    // ES: POST_ONLY: rechazar si la orden cruzaría el spread.
    if (tif === 'POST_ONLY' && this.wouldCross(order.side, order.price!)) {
      return { orderId: order.id, status: 'rejected', filled: 0n, filledQuote: 0n, resting: 0n, trades, makerUpdates, reason: 'post_only_would_take' };
    }

    let remaining = order.qty;
    let filledQuote = 0n;
    let reason: string | undefined;
    // EN: Opposite side structures. / ES: Estructuras del lado opuesto.
    const oppPrices = order.side === 'buy' ? this.askPrices : this.bidPrices;
    const oppLevels = order.side === 'buy' ? this.askLevels : this.bidLevels;

    while (remaining > 0n && oppPrices.length > 0) {
      const bestPrice = oppPrices[0]!;
      // EN: Limit price check: buy only up to price, sell only down to price.
      // ES: Control de precio límite: compra hasta el precio, vende desde el precio.
      if (order.type === 'limit') {
        if (order.side === 'buy' && bestPrice > order.price!) break;
        if (order.side === 'sell' && bestPrice < order.price!) break;
      }
      const level = oppLevels.get(bestPrice)!;
      const maker = level.orders[0]!;

      // EN: Self-trade prevention: cancel the taker's remainder, leave the maker untouched.
      // ES: Prevención de auto-trade: cancelamos el remanente del taker, el maker queda intacto.
      if (maker.userId === order.userId) {
        reason = 'self_trade_prevented';
        break;
      }

      let take = minBig(remaining, maker.remaining);
      // EN: Respect the quote budget (market buys): shrink to whole lots we can afford.
      // ES: Respetamos el presupuesto quote (compras a mercado): achicamos a lotes que se puedan pagar.
      if (order.side === 'buy' && order.maxQuote !== undefined) {
        const budgetLeft = order.maxQuote - filledQuote;
        const affordable = ((budgetLeft * this.unit) / bestPrice / this.spec.lotSize) * this.spec.lotSize;
        take = minBig(take, affordable);
        if (take === 0n) {
          reason = 'insufficient_quote_budget';
          break;
        }
      }

      const quoteQty = (bestPrice * take) / this.unit;
      // EN: Maker gets maker fee, taker gets taker fee; buyer pays in base, seller in quote.
      // ES: El maker paga comisión maker y el taker la taker; el comprador paga en base y el vendedor en quote.
      const buyerIsTaker = order.side === 'buy';
      const buyerFee = feeFor(take, buyerIsTaker ? this.spec.takerFeeBps : this.spec.makerFeeBps);
      const sellerFee = feeFor(quoteQty, buyerIsTaker ? this.spec.makerFeeBps : this.spec.takerFeeBps);

      trades.push({
        seq: this.tradeSeq++,
        marketId: this.spec.id,
        price: bestPrice,
        qty: take,
        quoteQty,
        takerSide: order.side,
        makerOrderId: maker.id,
        takerOrderId: order.id,
        buyOrderId: buyerIsTaker ? order.id : maker.id,
        sellOrderId: buyerIsTaker ? maker.id : order.id,
        buyerUserId: buyerIsTaker ? order.userId : maker.userId,
        sellerUserId: buyerIsTaker ? maker.userId : order.userId,
        buyerFee,
        sellerFee,
      });

      // EN: Update maker and level totals; remove fully filled makers.
      // ES: Actualizamos maker y totales del nivel; quitamos makers completamente ejecutados.
      maker.remaining -= take;
      level.total -= take;
      remaining -= take;
      filledQuote += quoteQty;
      if (maker.remaining === 0n) {
        level.orders.shift();
        this.index.delete(maker.id);
        makerUpdates.push({ orderId: maker.id, userId: maker.userId, remaining: 0n, status: 'filled' });
        if (level.orders.length === 0) this.removeLevel(maker.side, bestPrice);
      } else {
        makerUpdates.push({ orderId: maker.id, userId: maker.userId, remaining: maker.remaining, status: 'partially_filled' });
      }
    }

    const filled = order.qty - remaining;
    let resting = 0n;
    let status: SubmitResult['status'];
    if (remaining === 0n) {
      status = 'filled';
    } else if (tif === 'GTC' || tif === 'POST_ONLY') {
      if (reason === 'self_trade_prevented') {
        // EN: STP expired the taker remainder, so it does not rest.
        // ES: STP expiró el remanente del taker, así que no queda en el libro.
        status = 'canceled';
      } else {
        // EN: Rest the remainder at the limit price with a fresh sequence number.
        // ES: Dejamos el remanente al precio límite con un nuevo número de secuencia.
        this.rest({ id: order.id, userId: order.userId, side: order.side, price: order.price!, qty: order.qty, remaining, seq: this.orderSeq++ });
        resting = remaining;
        status = filled > 0n ? 'partially_filled' : 'open';
      }
    } else {
      // EN: IOC / market: the unfilled remainder is canceled.
      // ES: IOC / mercado: el remanente sin ejecutar se cancela.
      status = 'canceled';
      reason ??= filled > 0n ? 'ioc_remainder_canceled' : 'no_liquidity';
    }
    // EN: Consume a sequence even for non-resting orders to keep numbering deterministic.
    // ES: Consumimos secuencia aunque no quede en el libro para mantener numeración determinista.
    if (resting === 0n) this.orderSeq++;

    return { orderId: order.id, status, filled, filledQuote, resting, trades, makerUpdates, reason };
  }

  /**
   * EN: Cancels a resting order. Returns the removed order (with its remaining qty) or null.
   * ES: Cancela una orden en el libro. Devuelve la orden quitada (con su remanente) o null.
   */
  cancel(orderId: string): RestingOrder | null {
    const o = this.index.get(orderId);
    if (!o) return null;
    const levels = o.side === 'buy' ? this.bidLevels : this.askLevels;
    const level = levels.get(o.price)!;
    const i = level.orders.findIndex((x) => x.id === orderId);
    level.orders.splice(i, 1);
    level.total -= o.remaining;
    this.index.delete(orderId);
    if (level.orders.length === 0) this.removeLevel(o.side, o.price);
    return { ...o };
  }

  /**
   * EN: Cancels every resting order of a user (used by admin freeze). Returns removed orders.
   * ES: Cancela todas las órdenes de un usuario (lo usa el congelamiento admin). Devuelve las quitadas.
   */
  cancelAllForUser(userId: string): RestingOrder[] {
    const ids = [...this.index.values()].filter((o) => o.userId === userId).map((o) => o.id);
    return ids.map((id) => this.cancel(id)!).filter(Boolean);
  }

  /**
   * EN: Snapshot of the book in priority order (for persistence checks or recovery).
   * ES: Snapshot del libro en orden de prioridad (para controles de persistencia o recuperación).
   */
  snapshot(): BookSnapshot {
    const orders = [...this.index.values()].map((o) => ({ ...o })).sort((a, b) => a.seq - b.seq);
    return { marketId: this.spec.id, nextOrderSeq: this.orderSeq, nextTradeSeq: this.tradeSeq, orders };
  }

  /**
   * EN: Rebuilds a book from a snapshot (e.g. open orders loaded from Postgres after restart).
   * ES: Reconstruye un libro desde un snapshot (ej. órdenes abiertas leídas de Postgres al reiniciar).
   */
  static restore(spec: MarketSpec, snap: BookSnapshot): OrderBook {
    const book = new OrderBook(spec);
    for (const o of [...snap.orders].sort((a, b) => a.seq - b.seq)) {
      if (o.remaining <= 0n) continue;
      book.rest({ ...o });
    }
    book.orderSeq = Math.max(snap.nextOrderSeq, ...snap.orders.map((o) => o.seq + 1), 1);
    book.tradeSeq = Math.max(snap.nextTradeSeq, 1);
    return book;
  }

  // ---------------------------------------------------------------------------
  // EN: Internals / ES: Internos
  // ---------------------------------------------------------------------------

  /** EN: True if a limit order at `price` would take liquidity. / ES: True si una orden límite a `price` tomaría liquidez. */
  private wouldCross(side: Side, price: bigint): boolean {
    if (side === 'buy') return this.askPrices.length > 0 && this.askPrices[0]! <= price;
    return this.bidPrices.length > 0 && this.bidPrices[0]! >= price;
  }

  /**
   * EN: Inserts an order at the tail of its price level, creating the level if needed.
   * ES: Inserta una orden al final de su nivel de precio, creando el nivel si hace falta.
   */
  private rest(o: RestingOrder): void {
    const levels = o.side === 'buy' ? this.bidLevels : this.askLevels;
    let level = levels.get(o.price);
    if (!level) {
      level = { price: o.price, orders: [], total: 0n };
      levels.set(o.price, level);
      this.insertPrice(o.side, o.price);
    }
    level.orders.push(o);
    level.total += o.remaining;
    this.index.set(o.id, o);
  }

  /**
   * EN: Binary insertion into the sorted price array of a side.
   * ES: Inserción binaria en el arreglo ordenado de precios de un lado.
   */
  private insertPrice(side: Side, price: bigint): void {
    const arr = side === 'buy' ? this.bidPrices : this.askPrices;
    // EN: "better" means higher for bids and lower for asks.
    // ES: "mejor" significa más alto para bids y más bajo para asks.
    const better = (a: bigint, b: bigint) => (side === 'buy' ? a > b : a < b);
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (better(arr[mid]!, price)) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, price);
  }

  /** EN: Removes an empty level. / ES: Quita un nivel vacío. */
  private removeLevel(side: Side, price: bigint): void {
    const levels = side === 'buy' ? this.bidLevels : this.askLevels;
    levels.delete(price);
    // EN: Mutate in place: `submit` holds a reference to these arrays while matching.
    // ES: Mutamos en el lugar: `submit` mantiene una referencia a estos arreglos mientras cruza.
    const arr = side === 'buy' ? this.bidPrices : this.askPrices;
    const i = arr.indexOf(price);
    if (i >= 0) arr.splice(i, 1);
  }
}
