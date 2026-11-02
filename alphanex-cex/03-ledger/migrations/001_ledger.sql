-- EN: Double-entry ledger schema. All amounts are NUMERIC(78,0): integers in the asset's
--     smallest unit (fits uint256). No floating point anywhere.
-- ES: Esquema del ledger de partida doble. Todos los montos son NUMERIC(78,0): enteros en la
--     unidad mínima del activo (entra un uint256). Nada de punto flotante.

-- EN: Assets known to the ledger. / ES: Activos conocidos por el ledger.
CREATE TABLE IF NOT EXISTS assets (
  code        TEXT PRIMARY KEY,
  decimals    INT  NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  kind        TEXT NOT NULL CHECK (kind IN ('native', 'erc20', 'fiat')),
  -- EN: Token contract (NULL for native). / ES: Contrato del token (NULL para nativo).
  contract_address TEXT,
  confirmations INT NOT NULL DEFAULT 12
);

-- EN: One row per account. `code` is a structured name, e.g. "user:42:USDT:available".
--     `balance` is a materialised running total, updated in the SAME transaction as postings.
--     The CHECK makes overdrafts impossible even under concurrent writers.
-- ES: Una fila por cuenta. `code` es un nombre estructurado, ej. "user:42:USDT:available".
--     `balance` es un total materializado que se actualiza en la MISMA transacción que los asientos.
--     El CHECK vuelve imposibles los sobregiros incluso con escritores concurrentes.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  asset         TEXT NOT NULL REFERENCES assets(code),
  owner_type    TEXT NOT NULL,
  owner_id      TEXT,
  -- EN: 'debit' for assets/expenses (custody wallets), 'credit' for liabilities/revenue (user balances, fees).
  -- ES: 'debit' para activos/gastos (wallets de custodia), 'credit' para pasivos/ingresos (saldos de usuarios, fees).
  normal_side   TEXT NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
  balance       NUMERIC(78,0) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_non_negative CHECK (allow_negative OR balance >= 0)
);

-- EN: Journal entry header: one business event (deposit, trade, withdrawal...).
--     `idempotency_key` guarantees exactly-once posting even if a worker retries.
-- ES: Cabecera del asiento: un evento de negocio (depósito, trade, retiro...).
--     `idempotency_key` garantiza un único asiento aunque un worker reintente.
CREATE TABLE IF NOT EXISTS journal_entries (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL,
  ref             TEXT,
  idempotency_key TEXT UNIQUE,
  memo            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EN: Postings (lines). Amount is always positive; direction comes from `side`.
-- ES: Movimientos (líneas). El monto es siempre positivo; la dirección la da `side`.
CREATE TABLE IF NOT EXISTS postings (
  id         BIGSERIAL PRIMARY KEY,
  entry_id   BIGINT NOT NULL REFERENCES journal_entries(id),
  account_id BIGINT NOT NULL REFERENCES ledger_accounts(id),
  asset      TEXT NOT NULL REFERENCES assets(code),
  side       TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
  amount     NUMERIC(78,0) NOT NULL CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS postings_entry_idx ON postings(entry_id);
CREATE INDEX IF NOT EXISTS postings_account_idx ON postings(account_id);

-- EN: Append-only enforcement: journal and postings can never be updated or deleted.
--     Corrections are made with new reversing entries, as in real accounting.
-- ES: Solo-agregar: el diario y los movimientos nunca se actualizan ni borran.
--     Las correcciones se hacen con asientos de reversa nuevos, como en contabilidad real.
CREATE OR REPLACE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger tables are append-only (% on %)', TG_OP, TG_TABLE_NAME;
END
$$;
DROP TRIGGER IF EXISTS postings_append_only ON postings;
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
DROP TRIGGER IF EXISTS journal_append_only ON journal_entries;
CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
