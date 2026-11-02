/**
 * EN: Exchange accounting operations expressed as balanced journal entries.
 *     Every money movement in AlphaNex goes through one of these functions, so the
 *     full audit trail of a balance can always be explained entry by entry.
 * ES: Operaciones contables del exchange expresadas como asientos balanceados.
 *     Todo movimiento de dinero de AlphaNex pasa por una de estas funciones, así el
 *     historial completo de un saldo siempre se explica asiento por asiento.
 */
import type { Queryable } from './db.js';
import { custodyAccount, feeAccount, gasExpenseAccount, userAccount } from './accounts.js';
import type { Ledger, PostResult, PostingInput } from './ledger.js';

/**
 * EN: Minimal trade shape needed for settlement (matches the engine's Trade type).
 * ES: Forma mínima de un trade para liquidarlo (coincide con el tipo Trade del motor).
 */
export interface SettleableTrade {
  id: string;
  base: string;
  quote: string;
  qty: bigint;
  quoteQty: bigint;
  buyerUserId: string;
  sellerUserId: string;
  buyerFee: bigint;
  sellerFee: bigint;
}

// EN: Drops zero-amount lines (e.g. 0 fee) because postings must be > 0.
// ES: Quita líneas en cero (ej. fee 0) porque los movimientos deben ser > 0.
const nz = (lines: PostingInput[]) => lines.filter((l) => l.amount > 0n);

export class ExchangeAccounting {
  constructor(private readonly ledger: Ledger) {}

  /**
   * EN: Confirmed on-chain deposit: custody asset up, user liability up.
   *     Idempotent per on-chain event (txHash:logIndex) ⇒ a watcher retry can never double-credit.
   * ES: Depósito on-chain confirmado: sube el activo en custodia y el pasivo con el usuario.
   *     Idempotente por evento on-chain (txHash:logIndex) ⇒ un reintento del watcher nunca acredita doble.
   * EN: Deposit addresses are derived from the hot-wallet HD seed, so they belong to the "hot"
   *     custody perimeter; sweeping them into the main hot address does not change the ledger.
   * ES: Las direcciones de depósito derivan de la semilla HD de la hot wallet, así que pertenecen al
   *     perímetro de custodia "hot"; barrerlas a la dirección principal no cambia el ledger.
   */
  creditDeposit(tx: Queryable, a: { userId: string; asset: string; amount: bigint; eventId: string; wallet?: string }): Promise<PostResult> {
    return this.ledger.postIn(tx, {
      kind: 'deposit',
      ref: a.eventId,
      idempotencyKey: `deposit:${a.eventId}`,
      postings: [
        { account: custodyAccount(a.wallet ?? 'hot', a.asset), side: 'debit', amount: a.amount },
        { account: userAccount(a.userId, a.asset, 'available'), side: 'credit', amount: a.amount },
      ],
    });
  }

  /**
   * EN: Reverses a credited deposit (deep reorg incident). The user may go to 0 at most; if the
   *     funds were already spent the entry fails and ops must handle it manually (see runbook).
   * ES: Revierte un depósito acreditado (incidente de reorg profundo). El usuario puede quedar en 0
   *     como mucho; si ya gastó los fondos el asiento falla y ops lo resuelve a mano (ver runbook).
   */
  reverseDeposit(tx: Queryable, a: { userId: string; asset: string; amount: bigint; eventId: string; wallet?: string }): Promise<PostResult> {
    return this.ledger.postIn(tx, {
      kind: 'deposit_reversal',
      ref: a.eventId,
      idempotencyKey: `deposit_reversal:${a.eventId}`,
      postings: [
        { account: userAccount(a.userId, a.asset, 'available'), side: 'debit', amount: a.amount },
        { account: custodyAccount(a.wallet ?? 'hot', a.asset), side: 'credit', amount: a.amount },
      ],
    });
  }

  /**
   * EN: Holds funds for an open order: available → locked. Fails with InsufficientFundsError.
   * ES: Retiene fondos para una orden abierta: available → locked. Falla con InsufficientFundsError.
   */
  hold(tx: Queryable, a: { userId: string; asset: string; amount: bigint; orderId: string }): Promise<PostResult> {
    return this.ledger.postIn(tx, {
      kind: 'order_hold',
      ref: a.orderId,
      idempotencyKey: `hold:${a.orderId}`,
      postings: [
        { account: userAccount(a.userId, a.asset, 'available'), side: 'debit', amount: a.amount },
        { account: userAccount(a.userId, a.asset, 'locked'), side: 'credit', amount: a.amount },
      ],
    });
  }

  /**
   * EN: Releases unused hold (cancel, IOC remainder, price improvement): locked → available.
   * ES: Libera retención sin usar (cancelación, remanente IOC, mejora de precio): locked → available.
   */
  release(tx: Queryable, a: { userId: string; asset: string; amount: bigint; orderId: string; reason: string }): Promise<PostResult> | null {
    if (a.amount === 0n) return null;
    return this.ledger.postIn(tx, {
      kind: 'order_release',
      ref: a.orderId,
      idempotencyKey: `release:${a.orderId}:${a.reason}`,
      postings: [
        { account: userAccount(a.userId, a.asset, 'locked'), side: 'debit', amount: a.amount },
        { account: userAccount(a.userId, a.asset, 'available'), side: 'credit', amount: a.amount },
      ],
    });
  }

  /**
   * EN: Settles one trade atomically:
   *       buyer.locked(quote)  −quoteQty  → seller.available(quote) +(quoteQty − sellerFee), fees(quote) +sellerFee
   *       seller.locked(base)  −qty       → buyer.available(base)   +(qty − buyerFee),       fees(base)  +buyerFee
   *     Both legs balance independently, so value is conserved per asset by construction.
   * ES: Liquida un trade de forma atómica:
   *       comprador.locked(quote) −quoteQty → vendedor.available(quote) +(quoteQty − feeVendedor), fees(quote) +feeVendedor
   *       vendedor.locked(base)   −qty      → comprador.available(base) +(qty − feeComprador),      fees(base)  +feeComprador
   *     Cada pata balancea por separado, así el valor se conserva por activo por construcción.
   */
  settleTrade(tx: Queryable, t: SettleableTrade): Promise<PostResult> {
    return this.ledger.postIn(tx, {
      kind: 'trade',
      ref: t.id,
      idempotencyKey: `trade:${t.id}`,
      postings: nz([
        { account: userAccount(t.buyerUserId, t.quote, 'locked'), side: 'debit', amount: t.quoteQty },
        { account: userAccount(t.sellerUserId, t.quote, 'available'), side: 'credit', amount: t.quoteQty - t.sellerFee },
        { account: feeAccount(t.quote), side: 'credit', amount: t.sellerFee },
        { account: userAccount(t.sellerUserId, t.base, 'locked'), side: 'debit', amount: t.qty },
        { account: userAccount(t.buyerUserId, t.base, 'available'), side: 'credit', amount: t.qty - t.buyerFee },
        { account: feeAccount(t.base), side: 'credit', amount: t.buyerFee },
      ]),
    });
  }

  /**
   * EN: Withdrawal request: available → withdrawing (amount + fee). Funds stay owed to the user
   *     until the chain confirms the payout, so a failed broadcast can be refunded cleanly.
   * ES: Pedido de retiro: available → withdrawing (monto + fee). Los fondos se siguen debiendo al
   *     usuario hasta que la cadena confirme el pago, así un envío fallido se devuelve limpio.
   */
  reserveWithdrawal(tx: Queryable, a: { userId: string; asset: string; amount: bigint; fee: bigint; withdrawalId: string }): Promise<PostResult> {
    const total = a.amount + a.fee;
    return this.ledger.postIn(tx, {
      kind: 'withdrawal_reserve',
      ref: a.withdrawalId,
      idempotencyKey: `withdrawal_reserve:${a.withdrawalId}`,
      postings: [
        { account: userAccount(a.userId, a.asset, 'available'), side: 'debit', amount: total },
        { account: userAccount(a.userId, a.asset, 'withdrawing'), side: 'credit', amount: total },
      ],
    });
  }

  /**
   * EN: Rejected / failed withdrawal: withdrawing → available (full refund including fee).
   * ES: Retiro rechazado / fallido: withdrawing → available (devolución total incluida la fee).
   */
  refundWithdrawal(tx: Queryable, a: { userId: string; asset: string; amount: bigint; fee: bigint; withdrawalId: string }): Promise<PostResult> {
    const total = a.amount + a.fee;
    return this.ledger.postIn(tx, {
      kind: 'withdrawal_refund',
      ref: a.withdrawalId,
      idempotencyKey: `withdrawal_refund:${a.withdrawalId}`,
      postings: [
        { account: userAccount(a.userId, a.asset, 'withdrawing'), side: 'debit', amount: total },
        { account: userAccount(a.userId, a.asset, 'available'), side: 'credit', amount: total },
      ],
    });
  }

  /**
   * EN: Confirmed payout: user liability and hot-wallet asset both go down; the fee becomes
   *     revenue; gas actually paid (in the native asset) is booked as an expense of the venue.
   * ES: Pago confirmado: bajan el pasivo con el usuario y el activo de la hot wallet; la fee pasa a
   *     ingreso; el gas realmente pagado (en el activo nativo) se registra como gasto del exchange.
   */
  completeWithdrawal(
    tx: Queryable,
    a: { userId: string; asset: string; amount: bigint; fee: bigint; withdrawalId: string; gasAsset?: string; gasCost?: bigint; wallet?: string },
  ): Promise<PostResult> {
    const wallet = a.wallet ?? 'hot';
    const lines: PostingInput[] = [
      { account: userAccount(a.userId, a.asset, 'withdrawing'), side: 'debit', amount: a.amount + a.fee },
      { account: custodyAccount(wallet, a.asset), side: 'credit', amount: a.amount },
      { account: feeAccount(a.asset), side: 'credit', amount: a.fee },
    ];
    if (a.gasCost && a.gasCost > 0n) {
      const gasAsset = a.gasAsset ?? 'ETH';
      lines.push({ account: gasExpenseAccount(gasAsset), side: 'debit', amount: a.gasCost });
      lines.push({ account: custodyAccount(wallet, gasAsset), side: 'credit', amount: a.gasCost });
    }
    return this.ledger.postIn(tx, {
      kind: 'withdrawal_complete',
      ref: a.withdrawalId,
      idempotencyKey: `withdrawal_complete:${a.withdrawalId}`,
      postings: nz(lines),
    });
  }

  /**
   * EN: Internal transfer between custody wallets (deposit sweep, hot → cold rebalancing).
   *     Asset-to-asset entry: total custody is unchanged, only its location.
   * ES: Transferencia interna entre wallets de custodia (barrido de depósitos, rebalanceo hot → cold).
   *     Asiento activo-a-activo: la custodia total no cambia, solo su ubicación.
   */
  moveCustody(tx: Queryable, a: { asset: string; amount: bigint; from: string; to: string; ref: string }): Promise<PostResult> {
    return this.ledger.postIn(tx, {
      kind: 'custody_move',
      ref: a.ref,
      idempotencyKey: `custody_move:${a.ref}`,
      postings: [
        { account: custodyAccount(a.to, a.asset), side: 'debit', amount: a.amount },
        { account: custodyAccount(a.from, a.asset), side: 'credit', amount: a.amount },
      ],
    });
  }
}
