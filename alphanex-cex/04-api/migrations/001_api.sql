-- EN: AlphaNex API schema (users, sessions, markets, orders, trades, withdrawals, deposits, audit).
--     Money columns are NUMERIC(78,0) base units (fits uint256); the ledger stays the source of
--     truth for balances — these tables describe orders/requests, not money.
-- ES: Esquema de la API de AlphaNex (usuarios, sesiones, mercados, órdenes, trades, retiros,
--     depósitos, auditoría). Las columnas de dinero son NUMERIC(78,0) en unidades base (entra un
--     uint256); el ledger sigue siendo la fuente de verdad de saldos — estas tablas describen
--     órdenes/pedidos, no dinero.

-- EN: Accounts. Passwords are scrypt hashes; wallet_address is optional and unique (SIWE-style link).
-- ES: Cuentas. Las contraseñas son hashes scrypt; wallet_address es opcional y único (vínculo estilo SIWE).
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  wallet_address TEXT UNIQUE,
  frozen         BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EN: Opaque session tokens, stored only as sha256 hashes. / ES: Tokens de sesión opacos, guardados solo como hash sha256.
-- EN: Opaque bearer sessions; only sha256(token) is stored.
-- ES: Sesiones bearer opacas; solo se guarda sha256(token).
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EN: One-time challenges for wallet (SIWE-style) linking. / ES: Desafíos de un solo uso para vincular wallet (estilo SIWE).
-- EN: One pending wallet-link nonce per user; consumed with DELETE ... RETURNING.
-- ES: Un nonce pendiente de vínculo de wallet por usuario; se consume con DELETE ... RETURNING.
CREATE TABLE wallet_challenges (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  nonce      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- EN: Market catalogue; spec holds tick/lot/fees as strings. / ES: Catálogo de mercados; spec guarda tick/lote/fees como strings.
-- EN: Market specs (tick, lot, min, fees) as JSON + freeze flag.
-- ES: Specs de mercado (tick, lote, mínimo, fees) como JSON + flag de congelado.
CREATE TABLE markets (
  id      TEXT PRIMARY KEY,
  base    TEXT NOT NULL,
  quote   TEXT NOT NULL,
  spec    JSONB NOT NULL,
  frozen  BOOLEAN NOT NULL DEFAULT false
);

-- EN: Orders. hold_left = funds still locked in the ledger for this order.
-- ES: Órdenes. hold_left = fondos todavía bloqueados en el ledger para esta orden.
-- EN: Orders are the source of truth for the in-memory book. Amounts are integer base units (NUMERIC(78,0) fits uint256).
--     hold_left = funds still locked for this order; must equal the ledger's `locked` balance in aggregate.
-- ES: Las órdenes son la fuente de verdad del libro en memoria. Los montos son unidades enteras (NUMERIC(78,0) cabe un uint256).
--     hold_left = fondos aún bloqueados por la orden; en total debe igualar el saldo `locked` del ledger.
CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  market_id       TEXT NOT NULL REFERENCES markets(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  client_order_id TEXT,
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  type            TEXT NOT NULL CHECK (type IN ('limit','market')),
  tif             TEXT NOT NULL,
  price           NUMERIC(78,0),
  qty             NUMERIC(78,0) NOT NULL CHECK (qty > 0),
  remaining       NUMERIC(78,0) NOT NULL CHECK (remaining >= 0),
  filled          NUMERIC(78,0) NOT NULL DEFAULT 0,
  filled_quote    NUMERIC(78,0) NOT NULL DEFAULT 0,
  hold_asset      TEXT NOT NULL,
  hold_amount     NUMERIC(78,0) NOT NULL,
  hold_left       NUMERIC(78,0) NOT NULL CHECK (hold_left >= 0),
  status          TEXT NOT NULL,
  reason          TEXT,
  seq             BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- EN: Partial index: rebuilding the book only scans live orders.
-- ES: Índice parcial: reconstruir el libro solo recorre órdenes vivas.
CREATE INDEX orders_open_idx ON orders(market_id, status) WHERE status IN ('open','partially_filled');
CREATE INDEX orders_user_idx ON orders(user_id, created_at DESC);
-- EN: clientOrderId is unique per user (duplicate submit → 409).
-- ES: clientOrderId es único por usuario (envío duplicado → 409).
CREATE UNIQUE INDEX orders_client_id_idx ON orders(user_id, client_order_id) WHERE client_order_id IS NOT NULL;

-- EN: Executions. id = "<market>:<engine trade seq>". / ES: Ejecuciones. id = "<mercado>:<seq del motor>".
-- EN: Immutable fills; (market_id, seq) gives a total order per market for candles and replay.
-- ES: Ejecuciones inmutables; (market_id, seq) da un orden total por mercado para velas y replay.
CREATE TABLE trades (
  id             TEXT PRIMARY KEY,
  market_id      TEXT NOT NULL REFERENCES markets(id),
  seq            BIGINT NOT NULL,
  price          NUMERIC(78,0) NOT NULL,
  qty            NUMERIC(78,0) NOT NULL,
  quote_qty      NUMERIC(78,0) NOT NULL,
  taker_side     TEXT NOT NULL,
  maker_order_id TEXT NOT NULL,
  taker_order_id TEXT NOT NULL,
  buyer_user_id  TEXT NOT NULL,
  seller_user_id TEXT NOT NULL,
  buyer_fee      NUMERIC(78,0) NOT NULL,
  seller_fee     NUMERIC(78,0) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, seq)
);
CREATE INDEX trades_market_time_idx ON trades(market_id, created_at DESC);

-- EN: Hash-chained, append-only audit log. / ES: Log de auditoría append-only encadenado por hash.
-- EN: Append-only, hash-chained audit trail: hash = sha256(prev_hash | seq | at | actor | action | target | details).
-- ES: Auditoría solo-anexar encadenada por hash: hash = sha256(prev_hash | seq | at | actor | action | target | details).
CREATE TABLE audit_log (
  seq       BIGINT PRIMARY KEY,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  target    TEXT,
  details   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL UNIQUE
);
CREATE FUNCTION audit_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
-- EN: Defense in depth: UPDATE/DELETE on the audit log is refused by the database itself.
-- ES: Defensa en profundidad: la propia base rechaza UPDATE/DELETE sobre la auditoría.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_forbid_mutation();

-- EN: Withdrawal requests and approvals (two-person rule). / ES: Pedidos de retiro y aprobaciones (regla de dos personas).
-- EN: Withdrawal state machine: pending_approval → approved → broadcast → completed | failed; rejected refunds.
-- ES: Máquina de estados de retiros: pending_approval → approved → broadcast → completed | failed; rejected reintegra.
CREATE TABLE withdrawals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  asset       TEXT NOT NULL,
  to_address  TEXT NOT NULL,
  amount      NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  fee         NUMERIC(78,0) NOT NULL CHECK (fee >= 0),
  status      TEXT NOT NULL CHECK (status IN ('pending_approval','approved','broadcast','completed','rejected','failed')),
  tx_hash     TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_status_idx ON withdrawals(status);
-- EN: One row per (withdrawal, admin): the primary key makes double-approval impossible.
-- ES: Una fila por (retiro, admin): la clave primaria hace imposible la doble aprobación.
CREATE TABLE withdrawal_approvals (
  withdrawal_id TEXT NOT NULL REFERENCES withdrawals(id),
  admin_id      TEXT NOT NULL REFERENCES users(id),
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (withdrawal_id, admin_id)
);
-- EN: Per-asset limits in base units. / ES: Límites por activo en unidades base.
-- EN: Per-asset limits; no row = withdrawals disabled for that asset.
-- ES: Límites por activo; sin fila = retiros deshabilitados para ese activo.
CREATE TABLE withdrawal_limits (
  asset      TEXT PRIMARY KEY,
  per_tx_max NUMERIC(78,0) NOT NULL,
  daily_max  NUMERIC(78,0) NOT NULL,
  fee        NUMERIC(78,0) NOT NULL DEFAULT 0
);

-- EN: HD deposit addresses (one per user, shared by all EVM assets). / ES: Direcciones HD de depósito (una por usuario).
-- EN: Deposit addresses: HD index per user, derived from the xpub.
-- ES: Direcciones de depósito: índice HD por usuario, derivado del xpub.
CREATE SEQUENCE deposit_hd_index_seq START 1;
CREATE TABLE deposit_addresses (
  user_id  TEXT PRIMARY KEY REFERENCES users(id),
  address  TEXT NOT NULL UNIQUE,
  hd_index INTEGER NOT NULL UNIQUE
);
-- EN: Deposits seen by the watcher. id = txHash:logIndex. / ES: Depósitos vistos por el watcher. id = txHash:logIndex.
-- EN: On-chain deposits; id = "<txHash>:<logIndex|native>" so re-scans are idempotent; status follows the watcher callbacks.
-- ES: Depósitos on-chain; id = "<txHash>:<logIndex|native>" para que re-escanear sea idempotente; el estado sigue los callbacks del watcher.
CREATE TABLE deposits (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  asset        TEXT NOT NULL,
  amount       NUMERIC(78,0) NOT NULL,
  tx_hash      TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','credited','orphaned','reorged_after_credit')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EN: HTTP idempotency keys (per user). / ES: Claves de idempotencia HTTP (por usuario).
-- EN: Stored responses for Idempotency-Key replays (same key + same body → same answer).
-- ES: Respuestas guardadas para replays de Idempotency-Key (misma clave + mismo cuerpo → misma respuesta).
CREATE TABLE idempotency_keys (
  user_id      TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INTEGER,
  response     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- EN: Small key/value store (watcher state). / ES: Pequeño almacén clave/valor (estado del watcher).
-- EN: Small key/value store: watcher state, withdrawals_halted kill switch.
-- ES: Pequeño almacén clave/valor: estado del watcher, interruptor withdrawals_halted.
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
