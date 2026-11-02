/**
 * EN: Double-entry ledger service.
 *     Guarantees (all enforced inside ONE database transaction per entry):
 *       1. Every entry balances per asset: Σ debits == Σ credits.
 *       2. Balances never go negative (CHECK constraint ⇒ safe under concurrency).
 *       3. Exactly-once: an idempotency key can only be posted once.
 *       4. Append-only history (DB triggers), corrections are reversing entries.
 * ES: Servicio de ledger de partida doble.
 *     Garantías (todas dentro de UNA transacción de base de datos por asiento):
 *       1. Cada asiento balancea por activo: Σ débitos == Σ créditos.
 *       2. Los saldos nunca son negativos (CHECK ⇒ seguro con concurrencia).
 *       3. Una sola vez: una clave de idempotencia solo se puede asentar una vez.
 *       4. Historia solo-agregar (triggers), las correcciones son asientos de reversa.
 */
import type { Db, Queryable } from './db.js';
import { parseAccount, type NormalSide, type UserBucket, userAccount } from './accounts.js';
import { LEDGER_MIGRATIONS_DIR, loadMigrations, runMigrations } from './migrate.js';

/**
 * EN: One line of a journal entry. `amount` must be > 0; direction is `side`.
 * ES: Una línea de un asiento. `amount` debe ser > 0; la dirección la da `side`.
 */
export interface PostingInput {
  account: string;
  side: NormalSide;
  amount: bigint;
}

/**
 * EN: A journal entry to post.
 * ES: Un asiento a registrar.
 */
export interface EntryInput {
  kind: string;
  ref?: string;
  idempotencyKey?: string;
  memo?: string;
  postings: PostingInput[];
}

/** EN: Result of posting. / ES: Resultado de asentar. */
export interface PostResult {
  entryId: string;
  // EN: True if the idempotency key already existed (nothing was posted).
  // ES: True si la clave de idempotencia ya existía (no se asentó nada).
  duplicate: boolean;
}

/**
 * EN: Raised when an entry would overdraw a non-negative account.
 * ES: Se lanza cuando un asiento sobregiraría una cuenta no negativa.
 */
export class InsufficientFundsError extends Error {
  constructor(public readonly account: string) {
    super(`insufficient funds in ${account}`);
    this.name = 'InsufficientFundsError';
  }
}

/**
 * EN: Raised for structurally invalid entries (unbalanced, zero amounts...).
 * ES: Se lanza para asientos estructuralmente inválidos (desbalanceados, montos cero...).
 */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** EN: Per-user balance view. / ES: Vista de saldos por usuario. */
export type UserBalances = Record<string, Record<UserBucket, bigint>>;

/** EN: Report of the invariant checker. / ES: Reporte del verificador de invariantes. */
export interface InvariantReport {
  ok: boolean;
  problems: string[];
}

export class Ledger {
  constructor(private readonly db: Db) {}

  /**
   * EN: Applies ledger migrations (idempotent).
   * ES: Aplica las migraciones del ledger (idempotente).
   */
  async migrate(): Promise<void> {
    await runMigrations(this.db, loadMigrations(LEDGER_MIGRATIONS_DIR, 'ledger'));
  }

  /**
   * EN: Registers (or updates) an asset. / ES: Registra (o actualiza) un activo.
   */
  async upsertAsset(a: { code: string; decimals: number; kind: 'native' | 'erc20' | 'fiat'; contractAddress?: string | null; confirmations?: number }): Promise<void> {
    await this.db.query(
      `INSERT INTO assets(code, decimals, kind, contract_address, confirmations) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET contract_address = EXCLUDED.contract_address, confirmations = EXCLUDED.confirmations`,
      [a.code, a.decimals, a.kind, a.contractAddress ?? null, a.confirmations ?? 12],
    );
  }

  /**
   * EN: Posts an entry in its own transaction. Use `postIn` to compose with other writes.
   * ES: Asienta en su propia transacción. Usar `postIn` para combinar con otras escrituras.
   */
  post(entry: EntryInput): Promise<PostResult> {
    return this.db.transaction((tx) => this.postIn(tx, entry));
  }

  /**
   * EN: Posts an entry inside an existing transaction `tx`. Caller commits/rolls back.
   * ES: Asienta dentro de una transacción existente `tx`. Quien llama hace commit/rollback.
   */
  async postIn(tx: Queryable, entry: EntryInput): Promise<PostResult> {
    validateEntry(entry);

    // EN: 1) Claim the idempotency key first; a duplicate short-circuits without side effects.
    // ES: 1) Reservamos la clave de idempotencia primero; un duplicado corta sin efectos.
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO journal_entries(kind, ref, idempotency_key, memo) VALUES ($1,$2,$3,$4)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text AS id`,
      [entry.kind, entry.ref ?? null, entry.idempotencyKey ?? null, entry.memo ?? null],
    );
    if (ins.rows.length === 0) {
      const ex = await tx.query<{ id: string }>(`SELECT id::text AS id FROM journal_entries WHERE idempotency_key = $1`, [entry.idempotencyKey]);
      return { entryId: ex.rows[0]!.id, duplicate: true };
    }
    const entryId = ins.rows[0]!.id;

    // EN: 2) Touch accounts in a stable order (sorted codes) to avoid deadlocks between writers.
    // ES: 2) Tocamos las cuentas en orden estable (códigos ordenados) para evitar deadlocks entre escritores.
    const sorted = [...entry.postings].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
    for (const p of sorted) {
      const acc = await this.ensureAccountIn(tx, p.account);
      // EN: Same side as the account's normal side increases it; opposite side decreases it.
      // ES: El mismo lado que el normal de la cuenta la aumenta; el lado opuesto la disminuye.
      const delta = p.side === acc.normalSide ? p.amount : -p.amount;
      try {
        await tx.query(`UPDATE ledger_accounts SET balance = balance + $2::numeric WHERE id = $1`, [acc.id, delta.toString()]);
      } catch (e) {
        // EN: 23514 = check_violation ⇒ the non-negative constraint fired.
        // ES: 23514 = check_violation ⇒ saltó la restricción de no negativo.
        if (isCheckViolation(e)) throw new InsufficientFundsError(p.account);
        throw e;
      }
      await tx.query(`INSERT INTO postings(entry_id, account_id, asset, side, amount) VALUES ($1,$2,$3,$4,$5::numeric)`, [
        entryId,
        acc.id,
        acc.asset,
        p.side,
        p.amount.toString(),
      ]);
    }
    return { entryId, duplicate: false };
  }

  /**
   * EN: Returns the account row, creating it on first use (codes are validated by parseAccount).
   * ES: Devuelve la fila de la cuenta, creándola en el primer uso (los códigos se validan con parseAccount).
   */
  private async ensureAccountIn(tx: Queryable, code: string): Promise<{ id: string; asset: string; normalSide: NormalSide }> {
    const spec = parseAccount(code);
    const found = await tx.query<{ id: string; asset: string; normal_side: NormalSide }>(
      `SELECT id::text AS id, asset, normal_side FROM ledger_accounts WHERE code = $1`,
      [code],
    );
    if (found.rows[0]) return { id: found.rows[0].id, asset: found.rows[0].asset, normalSide: found.rows[0].normal_side };
    const created = await tx.query<{ id: string }>(
      `INSERT INTO ledger_accounts(code, asset, owner_type, owner_id, normal_side, allow_negative)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
       RETURNING id::text AS id`,
      [code, spec.asset, spec.ownerType, spec.ownerId, spec.normalSide, spec.allowNegative],
    );
    return { id: created.rows[0]!.id, asset: spec.asset, normalSide: spec.normalSide };
  }

  /**
   * EN: Balance of one account (0 if it does not exist yet). Pass `tx` to read inside a transaction.
   * ES: Saldo de una cuenta (0 si todavía no existe). Pasar `tx` para leer dentro de una transacción.
   */
  async balance(code: string, tx: Queryable = this.db): Promise<bigint> {
    const r = await tx.query<{ balance: string }>(`SELECT balance::text AS balance FROM ledger_accounts WHERE code = $1`, [code]);
    return r.rows[0] ? BigInt(r.rows[0].balance) : 0n;
  }

  /**
   * EN: All buckets of all assets for a user, e.g. { USDT: { available, locked, withdrawing } }.
   * ES: Todos los buckets de todos los activos de un usuario, ej. { USDT: { available, locked, withdrawing } }.
   */
  async userBalances(userId: string, tx: Queryable = this.db): Promise<UserBalances> {
    const r = await tx.query<{ code: string; asset: string; balance: string }>(
      `SELECT code, asset, balance::text AS balance FROM ledger_accounts WHERE owner_type = 'user' AND owner_id = $1`,
      [userId],
    );
    const out: UserBalances = {};
    for (const row of r.rows) {
      const bucket = row.code.split(':')[3] as UserBucket;
      out[row.asset] ??= { available: 0n, locked: 0n, withdrawing: 0n };
      out[row.asset]![bucket] = BigInt(row.balance);
    }
    return out;
  }

  /**
   * EN: Sum of balances grouped by asset for a given owner type (e.g. total user liabilities).
   * ES: Suma de saldos agrupada por activo para un tipo de dueño (ej. pasivo total con usuarios).
   */
  async totalsByOwnerType(ownerType: string, tx: Queryable = this.db): Promise<Record<string, bigint>> {
    const r = await tx.query<{ asset: string; total: string }>(
      `SELECT asset, COALESCE(SUM(balance),0)::text AS total FROM ledger_accounts WHERE owner_type = $1 GROUP BY asset`,
      [ownerType],
    );
    return Object.fromEntries(r.rows.map((x) => [x.asset, BigInt(x.total)]));
  }

  /**
   * EN: Full invariant audit (run by tests, by the reconciliation job and by admins):
   *       a) every entry balances per asset;
   *       b) materialised balances == Σ postings;
   *       c) per asset Σ debit-normal balances == Σ credit-normal balances (books balance);
   *       d) no forbidden negative balances.
   * ES: Auditoría completa de invariantes (la corren tests, el job de conciliación y admins):
   *       a) cada asiento balancea por activo;
   *       b) saldos materializados == Σ movimientos;
   *       c) por activo Σ saldos deudores == Σ saldos acreedores (los libros cierran);
   *       d) no hay saldos negativos prohibidos.
   */
  async checkInvariants(): Promise<InvariantReport> {
    const problems: string[] = [];
    const unbalanced = await this.db.query<{ entry_id: string; asset: string }>(
      `SELECT entry_id::text AS entry_id, asset FROM postings GROUP BY entry_id, asset
       HAVING SUM(CASE WHEN side='debit' THEN amount ELSE -amount END) <> 0`,
    );
    for (const u of unbalanced.rows) problems.push(`entry ${u.entry_id} unbalanced in ${u.asset}`);

    const drift = await this.db.query<{ code: string }>(
      `SELECT a.code FROM ledger_accounts a
       LEFT JOIN postings p ON p.account_id = a.id
       GROUP BY a.id, a.code, a.balance, a.normal_side
       HAVING a.balance <> COALESCE(SUM(CASE WHEN p.side = a.normal_side THEN p.amount ELSE -p.amount END), 0)`,
    );
    for (const d of drift.rows) problems.push(`balance drift in ${d.code}`);

    const books = await this.db.query<{ asset: string; debit: string; credit: string }>(
      `SELECT asset,
              COALESCE(SUM(balance) FILTER (WHERE normal_side='debit'),0)::text AS debit,
              COALESCE(SUM(balance) FILTER (WHERE normal_side='credit'),0)::text AS credit
       FROM ledger_accounts GROUP BY asset`,
    );
    for (const b of books.rows) if (b.debit !== b.credit) problems.push(`books do not balance for ${b.asset}: ${b.debit} != ${b.credit}`);

    const neg = await this.db.query<{ code: string }>(`SELECT code FROM ledger_accounts WHERE NOT allow_negative AND balance < 0`);
    for (const n of neg.rows) problems.push(`negative balance in ${n.code}`);

    return { ok: problems.length === 0, problems };
  }

  /**
   * EN: Journal history for an account (newest first) for statements / UI.
   * ES: Historial del diario para una cuenta (más nuevo primero) para extractos / UI.
   */
  async history(code: string, limit = 50): Promise<{ entryId: string; kind: string; ref: string | null; side: NormalSide; amount: bigint; createdAt: string }[]> {
    const r = await this.db.query<{ entry_id: string; kind: string; ref: string | null; side: NormalSide; amount: string; created_at: string }>(
      `SELECT p.entry_id::text AS entry_id, j.kind, j.ref, p.side, p.amount::text AS amount, j.created_at::text AS created_at
       FROM postings p JOIN ledger_accounts a ON a.id = p.account_id JOIN journal_entries j ON j.id = p.entry_id
       WHERE a.code = $1 ORDER BY p.id DESC LIMIT $2`,
      [code, limit],
    );
    return r.rows.map((x) => ({ entryId: x.entry_id, kind: x.kind, ref: x.ref, side: x.side, amount: BigInt(x.amount), createdAt: x.created_at }));
  }

  /** EN: Convenience for user bucket codes. / ES: Atajo para códigos de buckets de usuario. */
  static user = userAccount;
}

/**
 * EN: Structural validation: non-empty, positive amounts, single asset per account, balanced per asset.
 * ES: Validación estructural: no vacío, montos positivos, un activo por cuenta, balanceado por activo.
 */
export function validateEntry(entry: EntryInput): void {
  if (!entry.kind) throw new LedgerError('entry kind is required');
  if (entry.postings.length < 2) throw new LedgerError('an entry needs at least 2 postings');
  const net = new Map<string, bigint>();
  for (const p of entry.postings) {
    if (typeof p.amount !== 'bigint' || p.amount <= 0n) throw new LedgerError(`posting amount must be a positive bigint (${p.account})`);
    if (p.side !== 'debit' && p.side !== 'credit') throw new LedgerError('posting side must be debit|credit');
    const { asset } = parseAccount(p.account);
    net.set(asset, (net.get(asset) ?? 0n) + (p.side === 'debit' ? p.amount : -p.amount));
  }
  for (const [asset, v] of net) if (v !== 0n) throw new LedgerError(`entry is unbalanced for ${asset} by ${v}`);
}

/**
 * EN: Detects Postgres check_violation across drivers (pg and PGlite expose `code`).
 * ES: Detecta check_violation de Postgres en ambos drivers (pg y PGlite exponen `code`).
 */
function isCheckViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === '23514' || /violates check constraint/.test(err?.message ?? '');
}
