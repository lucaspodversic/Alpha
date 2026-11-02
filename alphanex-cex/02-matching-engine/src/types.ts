/**
 * EN: Public types of the matching engine. The engine is a pure, deterministic, in-memory
 *     component: same inputs in the same order ⇒ same outputs. It performs NO I/O; persistence
 *     and balance checks live in the ledger/API layers.
 * ES: Tipos públicos del motor de matching. El motor es un componente puro, determinista y en
 *     memoria: mismas entradas en el mismo orden ⇒ mismas salidas. NO hace I/O; la persistencia
 *     y el control de saldos viven en las capas de ledger/API.
 */

// EN: Order side from the point of view of the user.
// ES: Lado de la orden desde el punto de vista del usuario.
export type Side = 'buy' | 'sell';

// EN: Supported order types for the MVP (stop orders are future work).
// ES: Tipos de orden soportados en el MVP (las órdenes stop quedan para después).
export type OrderType = 'limit' | 'market';

/**
 * EN: Time in force. GTC rests on the book, IOC never rests, POST_ONLY is rejected if it would
 *     take liquidity (guarantees maker fee).
 * ES: Vigencia. GTC queda en el libro, IOC nunca queda, POST_ONLY se rechaza si tomaría
 *     liquidez (garantiza comisión maker).
 */
export type TimeInForce = 'GTC' | 'IOC' | 'POST_ONLY';

/**
 * EN: Static configuration of one spot market. All values are integers in base units.
 * ES: Configuración estática de un mercado spot. Todos los valores son enteros en unidades base.
 */
export interface MarketSpec {
  // EN: Market id, e.g. "ETH-USDT". / ES: Id del mercado, ej. "ETH-USDT".
  id: string;
  // EN: Base asset code (what is bought/sold). / ES: Activo base (lo que se compra/vende).
  base: string;
  // EN: Quote asset code (what prices are expressed in). / ES: Activo cotizado (en qué se expresa el precio).
  quote: string;
  // EN: Decimals of the base asset. / ES: Decimales del activo base.
  baseDecimals: number;
  // EN: Decimals of the quote asset. / ES: Decimales del activo cotizado.
  quoteDecimals: number;
  /**
   * EN: Price increment, in quote base units per ONE WHOLE base unit (10^baseDecimals).
   * ES: Incremento de precio, en unidades base de quote por UNA unidad entera del base (10^baseDecimals).
   */
  tickSize: bigint;
  // EN: Quantity increment in base units. / ES: Incremento de cantidad en unidades base.
  lotSize: bigint;
  // EN: Minimum order quantity in base units. / ES: Cantidad mínima de orden en unidades base.
  minQty: bigint;
  // EN: Maker fee in basis points. / ES: Comisión maker en puntos básicos.
  makerFeeBps: bigint;
  // EN: Taker fee in basis points. / ES: Comisión taker en puntos básicos.
  takerFeeBps: bigint;
}

/**
 * EN: Order as submitted to the engine (already authenticated and funded by the API).
 * ES: Orden tal como se envía al motor (ya autenticada y con fondos reservados por la API).
 */
export interface NewOrder {
  id: string;
  userId: string;
  side: Side;
  type: OrderType;
  // EN: Defaults to GTC for limit orders; market orders are always IOC.
  // ES: Por defecto GTC para límites; las órdenes de mercado son siempre IOC.
  tif?: TimeInForce;
  // EN: Required for limit orders. / ES: Obligatorio para órdenes límite.
  price?: bigint;
  // EN: Quantity in base units. / ES: Cantidad en unidades base.
  qty: bigint;
  /**
   * EN: Optional hard cap of quote to spend (market buys). The engine never exceeds it, so the
   *     funds held by the ledger are always enough.
   * ES: Tope opcional de quote a gastar (compras a mercado). El motor nunca lo supera, así los
   *     fondos retenidos por el ledger siempre alcanzan.
   */
  maxQuote?: bigint;
}

/**
 * EN: An order resting on the book.
 * ES: Una orden que descansa en el libro.
 */
export interface RestingOrder {
  id: string;
  userId: string;
  side: Side;
  price: bigint;
  // EN: Original quantity. / ES: Cantidad original.
  qty: bigint;
  // EN: Quantity still open. / ES: Cantidad todavía abierta.
  remaining: bigint;
  // EN: Arrival sequence: lower = earlier = higher time priority.
  // ES: Secuencia de llegada: menor = antes = mayor prioridad temporal.
  seq: number;
}

/**
 * EN: One execution between a resting maker and an incoming taker.
 * ES: Una ejecución entre un maker en el libro y un taker entrante.
 */
export interface Trade {
  // EN: Engine-wide monotonically increasing trade sequence.
  // ES: Secuencia de trades monótona creciente en todo el motor.
  seq: number;
  marketId: string;
  // EN: Execution price = maker price (price-time priority).
  // ES: Precio de ejecución = precio del maker (prioridad precio-tiempo).
  price: bigint;
  // EN: Executed base quantity. / ES: Cantidad base ejecutada.
  qty: bigint;
  // EN: Executed quote amount = price * qty / 10^baseDecimals (exact).
  // ES: Monto quote ejecutado = precio * cantidad / 10^baseDecimals (exacto).
  quoteQty: bigint;
  takerSide: Side;
  makerOrderId: string;
  takerOrderId: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  // EN: Fee charged to the buyer, in BASE units (deducted from what they receive).
  // ES: Comisión cobrada al comprador, en unidades BASE (se descuenta de lo que recibe).
  buyerFee: bigint;
  // EN: Fee charged to the seller, in QUOTE units (deducted from what they receive).
  // ES: Comisión cobrada al vendedor, en unidades QUOTE (se descuenta de lo que recibe).
  sellerFee: bigint;
}

// EN: Lifecycle status of an order. / ES: Estado del ciclo de vida de una orden.
export type OrderStatus = 'open' | 'partially_filled' | 'filled' | 'canceled' | 'rejected';

/**
 * EN: Status change of a maker order caused by a submission.
 * ES: Cambio de estado de una orden maker causado por un envío.
 */
export interface MakerUpdate {
  orderId: string;
  userId: string;
  remaining: bigint;
  status: OrderStatus;
}

/**
 * EN: Result of submitting one order.
 * ES: Resultado de enviar una orden.
 */
export interface SubmitResult {
  orderId: string;
  status: OrderStatus;
  // EN: Base quantity filled by this order. / ES: Cantidad base ejecutada por esta orden.
  filled: bigint;
  // EN: Quote amount spent/received by this order (before fees).
  // ES: Monto quote gastado/recibido por esta orden (antes de comisiones).
  filledQuote: bigint;
  // EN: Quantity left resting on the book (0 if not resting).
  // ES: Cantidad que queda en el libro (0 si no queda).
  resting: bigint;
  trades: Trade[];
  makerUpdates: MakerUpdate[];
  // EN: Why the order was rejected or its remainder canceled.
  // ES: Por qué la orden se rechazó o se canceló su remanente.
  reason?: string;
}

// EN: Aggregated price level for market data. / ES: Nivel de precio agregado para market data.
export interface DepthLevel {
  price: bigint;
  qty: bigint;
  orders: number;
}
