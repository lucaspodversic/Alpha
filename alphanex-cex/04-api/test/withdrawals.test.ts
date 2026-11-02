// EN: Withdrawals with limits, four-eyes approval, separate signer, broadcast/confirm, and audit-chain tamper detection.
// ES: Retiros con límites, aprobación de cuatro ojos, firmante separado, envío/confirmación y detección de alteración de auditoría.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { EnvKeyProvider, WithdrawalSigner } from '@alphanex/custody';
import { DirectSignerClient, FakeChainGateway } from '../src/index.js';
import { makeApp, call, user, balances, PW } from './helpers.js';

const PK = generatePrivateKey();
const HOT = privateKeyToAccount(PK).address;
const SECRET = randomBytes(32).toString('hex');
const DEST = privateKeyToAccount(generatePrivateKey()).address;

let h: Awaited<ReturnType<typeof makeApp>>;
let gw: FakeChainGateway;
let u: { token: string; id: string };
let a1: string;
let a2: string;

beforeAll(async () => {
  gw = new FakeChainGateway();
  const signer = new WithdrawalSigner(new EnvKeyProvider({ HOT_WALLET_PRIVATE_KEY: PK }), {
    hmacSecret: SECRET,
    allowedChainIds: [31337],
    minApprovals: 2,
    maxSkewMs: 60_000,
    assets: { ETH: { kind: 'native', perTxMax: 10n ** 18n, dailyMax: 3n * 10n ** 18n } },
  });
  h = await makeApp(
    { HOT_WALLET_ADDRESS: HOT, CHAIN_ID: '31337' },
    {
      gateway: gw,
      signer: new DirectSignerClient(signer, SECRET),
      bootstrapAdmins: [
        { email: 'ops1@example.com', password: PW },
        { email: 'ops2@example.com', password: PW },
      ],
    },
  );
  u = await user(h.app, 'carol@example.com');
  a1 = (await call(h.app, 'POST', '/auth/login', { body: { email: 'ops1@example.com', password: PW } })).json.token;
  a2 = (await call(h.app, 'POST', '/auth/login', { body: { email: 'ops2@example.com', password: PW } })).json.token;
  await call(h.app, 'POST', '/dev/faucet', { token: u.token, body: { asset: 'ETH', amount: '2' } });
  // EN: Book the hot wallet's real holdings (custody asset) so payouts + gas can be booked.
  // ES: Registrar lo que realmente tiene la hot wallet (activo de custodia) para poder asentar pagos + gas.
  await call(h.app, 'POST', '/admin/treasury/fund', { token: a1, body: { asset: 'ETH', amount: '5', ref: 'genesis-funding' } });
});
afterAll(async () => {
  await h.app.close();
  await h.db.close();
});

const req = (amount: string, to: string = DEST, headers?: Record<string, string>) =>
  call(h.app, 'POST', '/account/withdrawals', { token: u.token, body: { asset: 'ETH', to, amount }, headers });

describe('withdrawals', () => {
  it('are disabled until limits exist, then enforce them / están deshabilitados hasta configurar límites, y luego se aplican', async () => {
    // EN: Safe default: no limits configured → no withdrawals at all.
    // ES: Valor seguro por defecto: sin límites configurados → ningún retiro.
    expect((await req('0.1')).json.error).toBe('withdrawals_disabled');
    const l = await call(h.app, 'PUT', '/admin/limits/ETH', { token: a1, body: { perTxMax: '0.5', dailyMax: '0.8', fee: '0.001' } });
    expect(l.status).toBe(200);
    // EN: Over the per-transaction cap; then the zero address and our own hot wallet are refused.
    // ES: Supera el tope por transacción; luego se rechazan la dirección cero y nuestra propia hot wallet.
    expect((await req('0.6')).json.error).toBe('per_tx_limit');
    expect((await req('0.1', '0x0000000000000000000000000000000000000000')).status).toBe(400);
    expect((await req('0.1', HOT)).status).toBe(400);
  });

  it('two different admins must approve; requester cannot / dos admins distintos deben aprobar; el solicitante no', async () => {
    const r = await req('0.5', DEST, { 'idempotency-key': 'wd-key-00001' });
    expect(r.status).toBe(201);
    const id = r.json.withdrawal.id;
    // EN: Same Idempotency-Key → same withdrawal, never a second debit.
    // ES: Misma Idempotency-Key → mismo retiro, nunca un segundo débito.
    expect((await req('0.5', DEST, { 'idempotency-key': 'wd-key-00001' })).json.withdrawal.id).toBe(id);
    // EN: amount 0.5 + fee 0.001 moved from available to withdrawing.
    // ES: monto 0.5 + fee 0.001 movidos de available a withdrawing.
    expect((await balances(h.app, u.token)).ETH).toEqual({ available: '1.499', locked: '0', withdrawing: '0.501' });
    // EN: A normal user cannot approve; an unapproved withdrawal cannot be processed.
    // ES: Un usuario común no puede aprobar; un retiro sin aprobar no puede procesarse.
    expect((await call(h.app, 'POST', `/admin/withdrawals/${id}/approve`, { token: u.token })).status).toBe(403);
    expect((await call(h.app, 'POST', `/admin/withdrawals/${id}/process`, { token: a1 })).json.error).toBe('bad_status');
    await call(h.app, 'POST', `/admin/withdrawals/${id}/approve`, { token: a1 });
    // EN: The same admin approving twice does not count as two approvals.
    // ES: El mismo admin aprobando dos veces no cuenta como dos aprobaciones.
    expect((await call(h.app, 'POST', `/admin/withdrawals/${id}/approve`, { token: a1 })).status).toBe(403);
    const ok = await call(h.app, 'POST', `/admin/withdrawals/${id}/approve`, { token: a2 });
    expect(ok.json.withdrawal.status).toBe('approved');

    // EN: Signed by the separate signer, persisted, then broadcast. / ES: Firmado por el firmante separado, persistido y luego enviado.
    // EN: Signed by the (in-process) signer and sent to the fake gateway; tx hash must match the raw tx.
    // ES: Firmado por el firmante (en proceso) y enviado al gateway falso; el hash debe coincidir con la tx cruda.
    const p = await call(h.app, 'POST', `/admin/withdrawals/${id}/process`, { token: a1 });
    expect(p.json.withdrawal.status).toBe('broadcast');
    expect(gw.sent).toHaveLength(1);
    expect(p.json.withdrawal.txHash).toBe(keccak256(gw.sent[0]!));

    // EN: Reconciliation counts the in-flight amount. / ES: La conciliación cuenta el monto en vuelo.
    // EN: While broadcast, the amount counts as in-flight for reconciliation.
    // ES: Mientras está difundido, el monto cuenta como en tránsito para la conciliación.
    expect(await h.services.withdrawals.inFlight()).toEqual({ ETH: 500000000000000000n });

    // EN: Receipt arrives → completed; fee to revenue, gas to expense. / ES: Llega el recibo → completado; fee a ingreso, gas a gasto.
    gw.outcomes.set(p.json.withdrawal.txHash as Hex, { status: 'success', gasCostWei: 42_000_000_000_000n, blockNumber: 10n });
    expect((await call(h.app, 'POST', '/admin/withdrawals/confirm', { token: a2 })).json.changed).toBe(1);
    expect((await call(h.app, 'GET', '/account/withdrawals', { token: u.token })).json.withdrawals[0].status).toBe('completed');
    expect((await balances(h.app, u.token)).ETH).toEqual({ available: '1.499', locked: '0', withdrawing: '0' });
    // EN: Hot wallet custody: 5 − 0.5 paid − 0.000042 gas. / ES: Custodia hot: 5 − 0,5 pagado − 0,000042 gas.
    // EN: Custody decreased by amount + real gas; the user fee went to fees:ETH.
    // ES: La custodia bajó en monto + gas real; la fee del usuario fue a fees:ETH.
    expect((await h.services.ledger.totalsByOwnerType('custody')).ETH).toBe(4_499_958_000_000_000_000n);
    expect((await call(h.app, 'GET', '/admin/invariants', { token: a1 })).json.ok).toBe(true);
  });

  it('daily limit counts earlier withdrawals; reject refunds / el límite diario cuenta retiros previos; rechazar devuelve', async () => {
    // EN: 0.5 already used of the 0.8 daily cap → 0.4 does not fit.
    // ES: Ya se usaron 0.5 del tope diario de 0.8 → 0.4 no entra.
    expect((await req('0.4')).json.error).toBe('daily_limit');
    const r = await req('0.2');
    const id = r.json.withdrawal.id;
    const rj = await call(h.app, 'POST', `/admin/withdrawals/${id}/reject`, { token: a1, body: { reason: 'destination flagged' } });
    // EN: Reject returns amount + fee to available.
    // ES: Rechazar devuelve monto + fee a available.
    expect(rj.json.withdrawal.status).toBe('rejected');
    expect((await balances(h.app, u.token)).ETH.withdrawing).toBe('0');
  });

  it('frozen users cannot withdraw / usuarios congelados no pueden retirar', async () => {
    await call(h.app, 'POST', `/admin/users/${u.id}/freeze`, { token: a1, body: { frozen: true, reason: 'compliance review' } });
    expect((await req('0.01')).json.error).toBe('account_frozen');
    await call(h.app, 'POST', `/admin/users/${u.id}/freeze`, { token: a1, body: { frozen: false, reason: 'cleared' } });
  });

  it('a reverted payout becomes failed and can be refunded / un pago revertido queda failed y se puede devolver', async () => {
    const id = (await req('0.05')).json.withdrawal.id;
    await call(h.app, 'POST', `/admin/withdrawals/${id}/approve`, { token: a1 });
    await call(h.app, 'POST', `/admin/withdrawals/${id}/approve`, { token: a2 });
    const p = await call(h.app, 'POST', `/admin/withdrawals/${id}/process`, { token: a2 });
    gw.outcomes.set(p.json.withdrawal.txHash, { status: 'reverted', gasCostWei: 0n, blockNumber: 11n });
    await call(h.app, 'POST', '/admin/withdrawals/confirm', { token: a1 });
    // EN: Reverted on-chain → failed; funds stay in withdrawing until an admin rejects (refund).
    // ES: Revertido on-chain → failed; los fondos quedan en withdrawing hasta que un admin rechace (reintegro).
    expect((await call(h.app, 'GET', `/admin/withdrawals?status=failed`, { token: a1 })).json.withdrawals).toHaveLength(1);
    await call(h.app, 'POST', `/admin/withdrawals/${id}/reject`, { token: a1, body: { reason: 'refund after revert' } });
    expect((await balances(h.app, u.token)).ETH).toEqual({ available: '1.499', locked: '0', withdrawing: '0' });
    expect((await call(h.app, 'GET', '/admin/invariants', { token: a1 })).json.ok).toBe(true);
  });
});

describe('audit log', () => {
  it('is hash-chained, append-only and detects tampering / está encadenado por hash, es solo-append y detecta alteraciones', async () => {
    const v = (await call(h.app, 'GET', '/admin/audit/verify', { token: a1 })).json;
    expect(v.ok).toBe(true);
    expect(v.count).toBeGreaterThan(10);
    // EN: The DB trigger refuses edits. / ES: El trigger de la BD rechaza ediciones.
    // EN: The DB trigger refuses edits and deletes outright.
    // ES: El trigger de la BD rechaza ediciones y borrados directamente.
    await expect(h.db.query(`UPDATE audit_log SET actor = 'mallory' WHERE seq = 3`)).rejects.toThrow();
    await expect(h.db.query(`DELETE FROM audit_log WHERE seq = 3`)).rejects.toThrow();
    // EN: Even a superuser bypassing the trigger is detected by verify(). / ES: Aun un superusuario que salte el trigger es detectado por verify().
    await h.db.query(`SET session_replication_role = replica`);
    await h.db.query(`UPDATE audit_log SET actor = 'mallory' WHERE seq = 3`);
    await h.db.query(`SET session_replication_role = origin`);
    const t = (await call(h.app, 'GET', '/admin/audit/verify', { token: a1 })).json;
    // EN: Tampering with the trigger disabled is still detected by hash verification at the exact row.
    // ES: Una manipulación con el trigger deshabilitado igual se detecta al verificar los hashes, en la fila exacta.
    expect(t.ok).toBe(false);
    expect(t.brokenAt).toBe(3);
  });
});
