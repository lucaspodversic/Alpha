/**
 * EN: Operator actions: freeze/unfreeze users, dev faucet, gas top-up booking, health/invariants and
 *     reconciliation. Every mutation is written to the hash-chained audit log in the same transaction.
 * ES: Acciones de operador: congelar/descongelar usuarios, faucet de desarrollo, registro de recarga de
 *     gas, salud/invariantes y conciliación. Cada mutación se escribe en el log de auditoría
 *     encadenado en la misma transacción.
 */
import { formatUnits, parseUnits } from '@alphanex/matching-engine';
import { custodyAccount, equityAccount, userAccount, type Db, type Ledger } from '@alphanex/ledger';
import { onchainTotals, reconcile, type ChainReader, type ReconReport, type WatchedAsset } from '@alphanex/custody';
import type { Address } from 'viem';
import { badRequest, forbidden, notFound, unavailable } from '../errors.js';
import type { EventBus } from '../events.js';
import type { AuditLog } from './audit.js';
import type { ExchangeService } from './exchange.js';
import type { WithdrawalService } from './withdrawals.js';
import type { DepositService } from './deposits.js';

export class AdminService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly exchange: ExchangeService,
    private readonly withdrawals: WithdrawalService,
    private readonly deposits: DepositService,
    private readonly decimals: Record<string, number>,
    private readonly opts: { allowDevFaucet: boolean; chain?: ChainReader; watched?: WatchedAsset[]; hotWalletAddress?: string },
  ) {}

  /**
   * EN: Freezing a user blocks orders and withdrawals and cancels all open orders (releasing holds).
   * ES: Congelar a un usuario bloquea órdenes y retiros y cancela todas sus órdenes abiertas (liberando retenciones).
   */
  async setUserFrozen(actor: string, userId: string, frozen: boolean, reason: string): Promise<{ canceled: number }> {
    await this.db.transaction(async (tx) => {
      const r = await tx.query('UPDATE users SET frozen = $2 WHERE id = $1 RETURNING id', [userId, frozen]);
      if (!r.rows.length) throw notFound('user_not_found');
      await this.audit.append(tx, { actor, action: frozen ? 'user.freeze' : 'user.unfreeze', target: userId, details: { reason } });
    });
    const canceled = frozen ? await this.exchange.cancelAllForUser(userId, actor, 'account_frozen') : 0;
    this.bus.publish(`user:${userId}`, { type: 'account', frozen });
    return { canceled };
  }

  /**
   * EN: DEV ONLY: credits test funds from equity:faucet. Disabled unless ALLOW_DEV_FAUCET=true and not production.
   * ES: SOLO DEV: acredita fondos de prueba desde equity:faucet. Deshabilitado salvo ALLOW_DEV_FAUCET=true y no producción.
   */
  async devCredit(actor: string, userId: string, asset: string, amount: string): Promise<void> {
    if (!this.opts.allowDevFaucet) throw forbidden('faucet_disabled');
    const dec = this.decimals[asset];
    if (dec === undefined) throw badRequest('unsupported_asset');
    let v: bigint;
    try {
      v = parseUnits(String(amount), dec);
    } catch (e) {
      throw badRequest('invalid_amount', (e as Error).message);
    }
    if (v <= 0n) throw badRequest('invalid_amount');
    await this.db.transaction(async (tx) => {
      const u = await tx.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      if (!u.rows.length) throw notFound('user_not_found');
      const ref = `faucet:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      await this.ledger.postIn(tx, {
        kind: 'dev_faucet',
        ref,
        idempotencyKey: ref,
        postings: [
          { account: equityAccount('faucet', asset), side: 'debit', amount: v },
          { account: userAccount(userId, asset, 'available'), side: 'credit', amount: v },
        ],
      });
      await this.audit.append(tx, { actor, action: 'dev.credit', target: userId, details: { asset, amount } });
    });
  }

  /**
   * EN: Books venue capital sent to the hot wallet (e.g. ETH for gas): equity:treasury → custody:hot.
   *     The on-chain transfer itself is done by ops; reconciliation proves it arrived.
   * ES: Registra capital propio enviado a la hot wallet (ej. ETH para gas): equity:treasury → custody:hot.
   *     La transferencia on-chain la hace ops; la conciliación prueba que llegó.
   */
  async bookTreasuryFunding(actor: string, asset: string, amount: string, ref: string): Promise<void> {
    const dec = this.decimals[asset];
    if (dec === undefined) throw badRequest('unsupported_asset');
    if (!/^[A-Za-z0-9:_-]{4,100}$/.test(ref ?? '')) throw badRequest('invalid_ref');
    const v = parseUnits(String(amount), dec);
    await this.db.transaction(async (tx) => {
      await this.ledger.postIn(tx, {
        kind: 'treasury_funding',
        ref,
        idempotencyKey: `treasury:${ref}`,
        postings: [
          { account: custodyAccount('hot', asset), side: 'debit', amount: v },
          { account: equityAccount('treasury', asset), side: 'credit', amount: v },
        ],
      });
      await this.audit.append(tx, { actor, action: 'treasury.funding', target: asset, details: { amount, ref } });
    });
  }

  /** EN: Ledger + engine/DB + holds invariants in one report. / ES: Invariantes de ledger + motor/BD + retenciones en un reporte. */
  async invariants(): Promise<{ ok: boolean; problems: string[] }> {
    const l = await this.ledger.checkInvariants();
    const problems = [...l.problems, ...(await this.exchange.checkBooksAgainstDb()), ...(await this.exchange.checkHolds())];
    return { ok: problems.length === 0, problems };
  }

  /**
   * EN: On-chain vs ledger custody. A deficit is reported, audited and alerted; the runbook tells ops
   *     to pause withdrawals. Not automatic on purpose (an RPC glitch could cause false positives).
   * ES: On-chain vs custodia del ledger. Un déficit se reporta, audita y alerta; el runbook indica a ops
   *     pausar retiros. No es automático a propósito (una falla de RPC podría dar falsos positivos).
   */
  async reconcile(): Promise<ReconReport & { human: { asset: string; onchain: string; ledger: string; inFlight: string; diff: string; status: string }[] }> {
    const { chain, watched } = this.opts;
    if (!chain || !watched?.length) throw unavailable('chain_not_configured', 'RPC_URL is required for reconciliation');
    const addrs = [...(await this.deposits.allAddresses()), ...(this.opts.hotWalletAddress ? [this.opts.hotWalletAddress] : [])] as Address[];
    const onchain = await onchainTotals(chain, addrs, watched);
    const ledgerCustody = await this.ledger.totalsByOwnerType('custody');
    const relevant = Object.fromEntries(Object.entries(ledgerCustody).filter(([a]) => watched.some((w) => w.code === a)));
    const report = reconcile(onchain, relevant, { inFlight: await this.withdrawals.inFlight() });
    await this.audit.record({ actor: 'system', action: 'reconciliation.run', target: null, details: { ok: report.ok, lines: report.lines } });
    if (!report.ok) {
      // EN: Deficit = money missing on-chain vs. what we owe. Stop all outgoing value until a human investigates.
      // ES: Déficit = falta dinero on-chain frente a lo que debemos. Frenar toda salida hasta que una persona investigue.
      const deficits = report.lines.filter((l) => l.status === 'deficit').map((l) => l.asset);
      await this.withdrawals.setHalted('system', true, `reconciliation deficit: ${deficits.join(',') || 'unknown'}`);
      this.bus.publish('admin', { type: 'alert', severity: 'critical', message: 'reconciliation deficit', report });
    }
    // EN: Signed formatting (diff can be negative). / ES: Formato con signo (diff puede ser negativo).
    const f = (a: string, v: bigint) => (v < 0n ? '-' : '') + formatUnits(v < 0n ? -v : v, this.decimals[a] ?? 18);
    return { ...report, human: report.lines.map((l) => ({ asset: l.asset, onchain: f(l.asset, l.onchain), ledger: f(l.asset, l.ledger), inFlight: f(l.asset, l.inFlight), diff: f(l.asset, l.diff), status: l.status })) };
  }

  /** EN: Users list for the admin console. / ES: Lista de usuarios para la consola admin. */
  async users(limit = 200) {
    const r = await this.db.query<{ id: string; email: string; role: string; frozen: boolean; wallet_address: string | null; created_at: Date | string }>(
      'SELECT id, email, role, frozen, wallet_address, created_at FROM users ORDER BY created_at DESC LIMIT $1',
      [Math.min(limit, 1000)],
    );
    return r.rows.map((u) => ({ id: u.id, email: u.email, role: u.role, frozen: u.frozen, walletAddress: u.wallet_address, createdAt: new Date(u.created_at).toISOString() }));
  }
}
