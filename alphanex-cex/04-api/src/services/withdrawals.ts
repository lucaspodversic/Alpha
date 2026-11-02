/**
 * EN: Withdrawal workflow with a two-person rule.
 *
 *       request (user)  ──reserve funds──▶ pending_approval
 *       approve (admin #1, admin #2; never the requester) ──▶ approved
 *       process (ops)   ──prepare → sign (signer service) → persist hash → broadcast──▶ broadcast
 *       confirm         ──receipt ok → complete in ledger (fee + gas)──▶ completed
 *                       ──receipt reverted──▶ failed (funds stay reserved until an admin refunds)
 *       reject (admin)  ──refund──▶ rejected   (only before broadcast)
 *
 *     The tx hash is persisted BEFORE broadcasting, so a crash between both steps can never lead to
 *     signing a second transaction for the same withdrawal (the signer also refuses replays).
 *
 * ES: Flujo de retiros con regla de dos personas.
 *
 *       request (usuario) ──reservar fondos──▶ pending_approval
 *       approve (admin #1, admin #2; nunca el solicitante) ──▶ approved
 *       process (ops)     ──preparar → firmar (servicio firmante) → guardar hash → difundir──▶ broadcast
 *       confirm           ──recibo ok → completar en ledger (fee + gas)──▶ completed
 *                         ──recibo revertido──▶ failed (los fondos siguen reservados hasta que un admin reembolse)
 *       reject (admin)    ──reembolso──▶ rejected   (solo antes de difundir)
 *
 *     El hash se guarda ANTES de difundir, así una caída entre ambos pasos nunca lleva a firmar una
 *     segunda transacción para el mismo retiro (el firmante además rechaza replays).
 */
import { randomUUID } from 'node:crypto';
import { getAddress, isAddress, type Hex } from 'viem';
import { formatUnits, parseUnits, PrecisionError } from '@alphanex/matching-engine';
import { ExchangeAccounting, InsufficientFundsError, type Db } from '@alphanex/ledger';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../errors.js';
import type { EventBus } from '../events.js';
import { Mutex, big } from '../util.js';
import type { AuditLog } from './audit.js';
import type { ChainGateway, SignerClient } from './chain-gateway.js';

export interface AssetInfo {
  code: string;
  decimals: number;
  kind: 'native' | 'erc20';
}

export interface WithdrawalView {
  id: string;
  userId: string;
  asset: string;
  to: string;
  amount: string;
  fee: string;
  status: string;
  txHash: string | null;
  error: string | null;
  approvals: string[];
  createdAt: string;
}

// EN: Number of distinct admin approvals required. / ES: Aprobaciones distintas de admins requeridas.
// EN: Four-eyes rule: two DIFFERENT admins, neither of them the requester, must approve.
// ES: Regla de cuatro ojos: dos admins DISTINTOS, ninguno el solicitante, deben aprobar.
export const REQUIRED_APPROVALS = 2;

export class WithdrawalService {
  // EN: Processing is serialized: one nonce sequence for the hot wallet. / ES: El procesamiento se serializa: una secuencia de nonces.
  private readonly processing = new Mutex();

  constructor(
    private readonly db: Db,
    private readonly acct: ExchangeAccounting,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly assets: Record<string, AssetInfo>,
    private readonly opts: { chainId: number; hotWalletAddress?: string; gateway?: ChainGateway; signer?: SignerClient },
  ) {}

  /**
   * EN: Global withdrawal kill switch (kv key `withdrawals_halted`). Set automatically by a reconciliation
   *     deficit or manually by an admin; while set, no new request is accepted and nothing is signed.
   *     Approvals and rejections still work so ops can clean the queue.
   * ES: Interruptor global de retiros (clave kv `withdrawals_halted`). Lo activa automáticamente un déficit
   *     de conciliación o manualmente un admin; mientras esté activo no se aceptan pedidos nuevos ni se firma nada.
   *     Aprobar y rechazar siguen funcionando para que ops pueda limpiar la cola.
   */
  async haltStatus(): Promise<{ halted: boolean; reason: string | null }> {
    const r = await this.db.query<{ value: string }>("SELECT value FROM kv WHERE key = 'withdrawals_halted'");
    // EN: Value is the reason text; absent row = not halted. / ES: El valor es el motivo; sin fila = no detenido.
    return r.rows[0] ? { halted: true, reason: r.rows[0].value } : { halted: false, reason: null };
  }

  /** EN: Sets / clears the kill switch (audited). / ES: Activa / desactiva el interruptor (auditado). */
  async setHalted(actor: string, halted: boolean, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (halted)
        await tx.query("INSERT INTO kv(key, value) VALUES ('withdrawals_halted', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [reason.slice(0, 500)]);
      else await tx.query("DELETE FROM kv WHERE key = 'withdrawals_halted'");
      await this.audit.append(tx, { actor, action: halted ? 'withdrawals.halt' : 'withdrawals.resume', target: null, details: { reason } });
    });
    this.bus.publish('admin', { type: 'withdrawals_halted', halted, reason });
  }

  /** EN: Throws 403 while halted. / ES: Lanza 403 mientras esté detenido. */
  private async assertNotHalted(): Promise<void> {
    if ((await this.haltStatus()).halted) throw forbidden('withdrawals_halted');
  }

  /** EN: Asset lookup or 400. / ES: Busca el activo o 400. */
  private asset(code: string): AssetInfo {
    const a = this.assets[code];
    if (!a) throw badRequest('unsupported_asset');
    return a;
  }

  /** EN: User request; amount is a human decimal string. / ES: Pedido del usuario; monto como decimal legible. */
  async request(userId: string, input: { asset: string; to: string; amount: string }): Promise<WithdrawalView> {
    const a = this.asset(input.asset);
    // EN: Reject malformed and zero addresses; getAddress normalizes to EIP-55 checksum form.
    // ES: Rechazar direcciones mal formadas y la dirección cero; getAddress normaliza al checksum EIP-55.
    if (typeof input.to !== 'string' || !isAddress(input.to) || /^0x0{40}$/i.test(input.to)) throw badRequest('invalid_address');
    const to = getAddress(input.to);
    let amount: bigint;
    try {
      amount = parseUnits(String(input.amount), a.decimals);
    } catch (e) {
      if (e instanceof PrecisionError || e instanceof SyntaxError) throw badRequest('invalid_amount', (e as Error).message);
      throw e;
    }
    if (amount <= 0n) throw badRequest('invalid_amount');
    await this.assertNotHalted();
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      // EN: Lock the user row: serializes concurrent withdrawals of the same user (daily-limit race).
      // ES: Bloquear la fila del usuario: serializa retiros concurrentes del mismo usuario (carrera del límite diario).
      const u = await tx.query<{ frozen: boolean }>('SELECT frozen FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!u.rows[0]) throw notFound('user_not_found');
      if (u.rows[0].frozen) throw forbidden('account_frozen');
      // EN: Refuse sending to our own deposit addresses (internal loops confuse reconciliation).
      // ES: Rechazar envíos a nuestras propias direcciones de depósito (los bucles internos confunden la conciliación).
      // EN: Sending to one of OUR addresses would create a phantom deposit loop; refuse it.
      // ES: Enviar a una de NUESTRAS direcciones crearía un bucle de depósito fantasma; se rechaza.
      const own = await tx.query('SELECT 1 FROM deposit_addresses WHERE lower(address) = lower($1)', [to]);
      if (own.rows.length || (this.opts.hotWalletAddress && this.opts.hotWalletAddress.toLowerCase() === to.toLowerCase())) throw badRequest('internal_address');
      const lim = await tx.query<{ per_tx_max: string; daily_max: string; fee: string }>(
        'SELECT per_tx_max::text AS per_tx_max, daily_max::text AS daily_max, fee::text AS fee FROM withdrawal_limits WHERE asset = $1',
        [a.code],
      );
      // EN: No configured limit = withdrawals disabled for the asset (fail closed). / ES: Sin límite configurado = retiros deshabilitados (falla cerrado).
      // EN: No limits row for the asset = withdrawals disabled for it (safe default).
      // ES: Sin fila de límites para el activo = retiros deshabilitados (valor seguro por defecto).
      const l = lim.rows[0];
      if (!l) throw forbidden('withdrawals_disabled');
      if (amount > big(l.per_tx_max)) throw badRequest('per_tx_limit', `max ${formatUnits(big(l.per_tx_max), a.decimals)} ${a.code}`);
      const day = await tx.query<{ s: string | null }>(
        `SELECT SUM(amount)::text AS s FROM withdrawals WHERE user_id = $1 AND asset = $2
         AND status NOT IN ('rejected') AND created_at > now() - interval '24 hours'`,
        [userId, a.code],
      );
      // EN: Rolling 24h sum of non-rejected withdrawals plus this one must fit the daily cap.
      // ES: La suma móvil de 24h de retiros no rechazados más este debe entrar en el tope diario.
      if (big(day.rows[0]?.s) + amount > big(l.daily_max)) throw badRequest('daily_limit');
      // EN: Move amount+fee from available to withdrawing in the ledger; CHECK >= 0 prevents overdraft.
      // ES: Mover monto+fee de available a withdrawing en el ledger; el CHECK >= 0 impide el sobregiro.
      const fee = big(l.fee);
      try {
        await this.acct.reserveWithdrawal(tx, { userId, asset: a.code, amount, fee, withdrawalId: id });
      } catch (e) {
        if (e instanceof InsufficientFundsError) throw badRequest('insufficient_funds');
        throw e;
      }
      await tx.query(`INSERT INTO withdrawals(id, user_id, asset, to_address, amount, fee, status) VALUES ($1,$2,$3,$4,$5,$6,'pending_approval')`, [
        id,
        userId,
        a.code,
        to,
        amount.toString(),
        fee.toString(),
      ]);
      await this.audit.append(tx, { actor: userId, action: 'withdrawal.request', target: id, details: { asset: a.code, to, amount, fee } });
    });
    this.bus.publish(`user:${userId}`, { type: 'withdrawal', id, status: 'pending_approval' });
    return (await this.get(id))!;
  }

  /**
   * EN: Admin approval. Same admin twice or the requester → 403. Second distinct approval → approved.
   * ES: Aprobación de admin. Mismo admin dos veces o el solicitante → 403. Segunda aprobación distinta → approved.
   */
  async approve(adminId: string, withdrawalId: string): Promise<WithdrawalView> {
    await this.db.transaction(async (tx) => {
      const w = await tx.query<{ user_id: string; status: string }>('SELECT user_id, status FROM withdrawals WHERE id = $1 FOR UPDATE', [withdrawalId]);
      const row = w.rows[0];
      if (!row) throw notFound('withdrawal_not_found');
      if (row.status !== 'pending_approval') throw conflict('bad_status', `status is ${row.status}`);
      // EN: An admin cannot approve their own withdrawal, and each admin counts only once (PK on the pair).
      // ES: Un admin no puede aprobar su propio retiro y cada admin cuenta una sola vez (PK sobre el par).
      if (row.user_id === adminId) throw forbidden('self_approval');
      const ins = await tx.query('INSERT INTO withdrawal_approvals(withdrawal_id, admin_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING admin_id', [withdrawalId, adminId]);
      if (!ins.rows.length) throw forbidden('already_approved_by_you');
      const n = await tx.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM withdrawal_approvals WHERE withdrawal_id = $1', [withdrawalId]);
      const count = Number(n.rows[0]!.n);
      if (count >= REQUIRED_APPROVALS) await tx.query(`UPDATE withdrawals SET status = 'approved', updated_at = now() WHERE id = $1`, [withdrawalId]);
      await this.audit.append(tx, { actor: adminId, action: 'withdrawal.approve', target: withdrawalId, details: { approvals: count } });
    });
    return (await this.get(withdrawalId))!;
  }

  /** EN: Admin rejection (refunds). Not allowed after broadcast. / ES: Rechazo de admin (reembolsa). No permitido tras difundir. */
  async reject(adminId: string, withdrawalId: string, reason: string): Promise<WithdrawalView> {
    let userId = '';
    await this.db.transaction(async (tx) => {
      const w = await tx.query<{ user_id: string; status: string; asset: string; amount: string; fee: string }>(
        'SELECT user_id, status, asset, amount::text AS amount, fee::text AS fee FROM withdrawals WHERE id = $1 FOR UPDATE',
        [withdrawalId],
      );
      const row = w.rows[0];
      if (!row) throw notFound('withdrawal_not_found');
      // EN: 'failed' (reverted on-chain) can also be refunded after investigation. / ES: 'failed' (revertido on-chain) también puede reembolsarse tras investigar.
      // EN: Once broadcast, the funds may already be on-chain: rejecting would double-pay. Only pre-broadcast or failed.
      // ES: Una vez difundido, los fondos pueden estar ya on-chain: rechazar pagaría dos veces. Solo antes de difundir o si falló.
      if (!['pending_approval', 'approved', 'failed'].includes(row.status)) throw conflict('bad_status', `status is ${row.status}`);
      userId = row.user_id;
      await this.acct.refundWithdrawal(tx, { userId: row.user_id, asset: row.asset, amount: big(row.amount), fee: big(row.fee), withdrawalId });
      await tx.query(`UPDATE withdrawals SET status = 'rejected', error = $2, updated_at = now() WHERE id = $1`, [withdrawalId, String(reason ?? '').slice(0, 500)]);
      await this.audit.append(tx, { actor: adminId, action: 'withdrawal.reject', target: withdrawalId, details: { reason } });
    });
    this.bus.publish(`user:${userId}`, { type: 'withdrawal', id: withdrawalId, status: 'rejected' });
    return (await this.get(withdrawalId))!;
  }

  /**
   * EN: Signs and broadcasts one approved withdrawal (serialized for nonce safety).
   * ES: Firma y difunde un retiro aprobado (serializado por seguridad de nonces).
   */
  async process(actor: string, withdrawalId: string): Promise<WithdrawalView> {
    const { gateway, signer, hotWalletAddress, chainId } = this.opts;
    if (!gateway || !signer || !hotWalletAddress) throw unavailable('custody_not_configured', 'RPC_URL, SIGNER_URL and HOT_WALLET_ADDRESS are required');
    return this.processing.run(async () => {
      const w = await this.get(withdrawalId);
      if (!w) throw notFound('withdrawal_not_found');
      if (w.status !== 'approved') throw conflict('bad_status', `status is ${w.status}`);
      // EN: Re-checked inside the mutex: a halt set while waiting still wins. / ES: Se re-chequea dentro del mutex: un halt puesto mientras se esperaba gana igual.
      await this.assertNotHalted();
      const a = this.asset(w.asset);
      // EN: Nonce and EIP-1559 fees come from the node; the signer re-validates limits and approvals independently.
      // ES: Nonce y fees EIP-1559 vienen del nodo; el firmante re-valida límites y aprobaciones de forma independiente.
      const p = await gateway.prepare(hotWalletAddress, a.kind);
      const signed = await signer.sign({
        withdrawalId: w.id,
        asset: w.asset,
        to: w.to,
        amount: parseUnits(w.amount, a.decimals).toString(),
        chainId,
        nonce: p.nonce,
        gas: p.gas.toString(),
        maxFeePerGas: p.maxFeePerGas.toString(),
        maxPriorityFeePerGas: p.maxPriorityFeePerGas.toString(),
        requestedBy: w.userId,
        approvals: w.approvals,
        timestamp: Date.now(),
      });
      // EN: Persist hash first (see header). / ES: Guardar el hash primero (ver encabezado).
      await this.db.transaction(async (tx) => {
        const u = await tx.query(`UPDATE withdrawals SET status = 'broadcast', tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'approved' RETURNING id`, [w.id, signed.txHash]);
        if (!u.rows.length) throw conflict('bad_status');
        await this.audit.append(tx, { actor, action: 'withdrawal.signed', target: w.id, details: { txHash: signed.txHash, nonce: p.nonce, from: signed.from } });
      });
      try {
        // EN: Status is persisted as `broadcast` BEFORE sending: if we crash after sending, we never re-sign
        //     a second tx; confirmBroadcasts() will find the receipt by hash.
        // ES: El estado se guarda como `broadcast` ANTES de enviar: si caemos después de enviar, nunca se firma
        //     una segunda tx; confirmBroadcasts() encontrará el recibo por hash.
        await gateway.broadcast(signed.rawTx);
      } catch (e) {
        // EN: Keep status 'broadcast': the signed tx may still land. Ops can rebroadcast the same raw tx.
        // ES: Mantener 'broadcast': la tx firmada todavía puede entrar. Ops puede re-difundir la misma tx.
        await this.db.query('UPDATE withdrawals SET error = $2, updated_at = now() WHERE id = $1', [w.id, `broadcast error: ${(e as Error).message}`.slice(0, 500)]);
      }
      this.bus.publish(`user:${w.userId}`, { type: 'withdrawal', id: w.id, status: 'broadcast' });
      return (await this.get(w.id))!;
    });
  }

  /**
   * EN: Checks receipts of broadcast withdrawals and finalizes them in the ledger. Returns how many changed.
   * ES: Revisa recibos de retiros difundidos y los finaliza en el ledger. Devuelve cuántos cambiaron.
   */
  async confirmBroadcasts(nativeAsset = 'ETH'): Promise<number> {
    const gateway = this.opts.gateway;
    if (!gateway) return 0;
    const r = await this.db.query<{ id: string; tx_hash: string }>(`SELECT id, tx_hash FROM withdrawals WHERE status = 'broadcast' AND tx_hash IS NOT NULL ORDER BY created_at`);
    let changed = 0;
    for (const row of r.rows) {
      // EN: No receipt yet = still in the mempool; try again on the next tick.
      // ES: Sin recibo todavía = sigue en la mempool; se reintenta en el próximo ciclo.
      const out = await gateway.receipt(row.tx_hash as Hex);
      if (!out) continue;
      await this.db.transaction(async (tx) => {
        const w = await tx.query<{ user_id: string; asset: string; amount: string; fee: string; status: string }>(
          'SELECT user_id, asset, amount::text AS amount, fee::text AS fee, status FROM withdrawals WHERE id = $1 FOR UPDATE',
          [row.id],
        );
        const x = w.rows[0]!;
        // EN: Re-checked under FOR UPDATE: another worker may have finalized it meanwhile.
        // ES: Re-chequeado con FOR UPDATE: otro worker pudo haberlo finalizado mientras tanto.
        if (x.status !== 'broadcast') return;
        if (out.status === 'success') {
          await this.acct.completeWithdrawal(tx, {
            userId: x.user_id,
            asset: x.asset,
            amount: big(x.amount),
            fee: big(x.fee),
            withdrawalId: row.id,
            gasAsset: nativeAsset,
            gasCost: out.gasCostWei,
          });
          await tx.query(`UPDATE withdrawals SET status = 'completed', error = NULL, updated_at = now() WHERE id = $1`, [row.id]);
        } else {
          await tx.query(`UPDATE withdrawals SET status = 'failed', error = 'reverted on-chain', updated_at = now() WHERE id = $1`, [row.id]);
        }
        await this.audit.append(tx, { actor: 'system', action: `withdrawal.${out.status === 'success' ? 'completed' : 'failed'}`, target: row.id, details: { block: out.blockNumber, gasCostWei: out.gasCostWei } });
        changed++;
        this.bus.publish(`user:${x.user_id}`, { type: 'withdrawal', id: row.id, status: out.status === 'success' ? 'completed' : 'failed' });
      });
    }
    return changed;
  }

  /** EN: Sum of reserved-but-not-yet-sent amounts per asset (for reconciliation). / ES: Suma reservada pero aún no enviada por activo (para conciliación). */
  async inFlight(): Promise<Record<string, bigint>> {
    // EN: Broadcast-but-unconfirmed withdrawals already left the wallet on-chain but not in the ledger.
    // ES: Retiros difundidos sin confirmar ya salieron on-chain pero no del ledger.
    const r = await this.db.query<{ asset: string; s: string }>(`SELECT asset, SUM(amount)::text AS s FROM withdrawals WHERE status = 'broadcast' GROUP BY asset`);
    return Object.fromEntries(r.rows.map((x) => [x.asset, big(x.s)]));
  }

  /** EN: Single view. / ES: Vista individual. */
  async get(id: string): Promise<WithdrawalView | null> {
    const rows = await this.query('WHERE w.id = $1', [id]);
    return rows[0] ?? null;
  }

  /** EN: Lists by user or status. / ES: Lista por usuario o estado. */
  list(filter: { userId?: string; status?: string; limit?: number }): Promise<WithdrawalView[]> {
    return this.query(`WHERE ($1::text IS NULL OR w.user_id = $1) AND ($2::text IS NULL OR w.status = $2) ORDER BY w.created_at DESC LIMIT $3`, [
      filter.userId ?? null,
      filter.status ?? null,
      Math.min(filter.limit ?? 100, 500),
    ]);
  }

  private async query(where: string, params: unknown[]): Promise<WithdrawalView[]> {
    const r = await this.db.query<{ id: string; user_id: string; asset: string; to_address: string; amount: string; fee: string; status: string; tx_hash: string | null; error: string | null; created_at: Date | string; approvals: string[] | null }>(
      `SELECT w.id, w.user_id, w.asset, w.to_address, w.amount::text AS amount, w.fee::text AS fee, w.status, w.tx_hash, w.error, w.created_at,
              (SELECT array_agg(admin_id ORDER BY at) FROM withdrawal_approvals a WHERE a.withdrawal_id = w.id) AS approvals
       FROM withdrawals w ${where}`,
      params,
    );
    return r.rows.map((x) => {
      const dec = this.assets[x.asset]?.decimals ?? 18;
      return {
        id: x.id,
        userId: x.user_id,
        asset: x.asset,
        to: x.to_address,
        amount: formatUnits(big(x.amount), dec),
        fee: formatUnits(big(x.fee), dec),
        status: x.status,
        txHash: x.tx_hash,
        error: x.error,
        approvals: x.approvals ?? [],
        createdAt: new Date(x.created_at).toISOString(),
      };
    });
  }

  /** EN: Admin sets limits (human units). / ES: El admin fija límites (unidades legibles). */
  async setLimits(adminId: string, asset: string, l: { perTxMax: string; dailyMax: string; fee: string }): Promise<void> {
    const a = this.asset(asset);
    let v: bigint[];
    try {
      v = [l.perTxMax, l.dailyMax, l.fee].map((x) => parseUnits(String(x), a.decimals));
    } catch (e) {
      throw badRequest('invalid_amount', (e as Error).message);
    }
    if (v[0]! > v[1]!) throw badRequest('per_tx_above_daily');
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO withdrawal_limits(asset, per_tx_max, daily_max, fee) VALUES ($1,$2,$3,$4)
         ON CONFLICT (asset) DO UPDATE SET per_tx_max = EXCLUDED.per_tx_max, daily_max = EXCLUDED.daily_max, fee = EXCLUDED.fee`,
        [a.code, v[0]!.toString(), v[1]!.toString(), v[2]!.toString()],
      );
      await this.audit.append(tx, { actor: adminId, action: 'limits.set', target: a.code, details: { perTxMax: l.perTxMax, dailyMax: l.dailyMax, fee: l.fee } });
    });
  }

  /** EN: Current limits (human units). / ES: Límites actuales (unidades legibles). */
  async getLimits() {
    const r = await this.db.query<{ asset: string; per_tx_max: string; daily_max: string; fee: string }>(
      'SELECT asset, per_tx_max::text AS per_tx_max, daily_max::text AS daily_max, fee::text AS fee FROM withdrawal_limits ORDER BY asset',
    );
    return r.rows.map((x) => {
      const d = this.assets[x.asset]?.decimals ?? 18;
      return { asset: x.asset, perTxMax: formatUnits(big(x.per_tx_max), d), dailyMax: formatUnits(big(x.daily_max), d), fee: formatUnits(big(x.fee), d) };
    });
  }
}
