'use client';
/**
 * EN: Funding: deposit address (HD-derived per user), deposit history, withdrawal request with
 *     limits shown, withdrawal history, and a DEV faucet button (only works when the API enables it).
 * ES: Fondos: dirección de depósito (derivada HD por usuario), historial de depósitos, pedido de
 *     retiro mostrando límites, historial de retiros y un botón de faucet DEV (solo si la API lo habilita).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Balances } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useChannels } from '@/lib/ws';
import { BalancesPanel } from '@/components/BalancesPanel';

// EN: Deposit row: `id` is "<txHash>:<logIndex|native>", unique per on-chain transfer (no double credit).
// ES: Fila de depósito: `id` es "<txHash>:<logIndex|native>", única por transferencia on-chain (sin doble acreditación).
interface Dep {
  id: string;
  asset: string;
  amount: string;
  txHash: string;
  status: string;
  confirmations?: number;
}
// EN: Withdrawal row; txHash appears only after an admin signs and broadcasts.
// ES: Fila de retiro; txHash aparece solo después de que un admin firma y difunde.
interface Wd {
  id: string;
  asset: string;
  to: string;
  amount: string;
  fee: string;
  status: string;
  txHash: string | null;
}

export default function FundingPage() {
  const { user, ready } = useSession();
  // EN: The deposit address is fetched on demand (it is derived and stored server-side on first use).
  // ES: La dirección de depósito se pide bajo demanda (se deriva y guarda en el servidor al primer uso).
  const [addr, setAddr] = useState<{ address: string; chainId: number; assets: { code: string; contract: string | null; confirmations: number }[] } | null>(null);
  const [addrErr, setAddrErr] = useState<string | null>(null);
  const [deps, setDeps] = useState<Dep[]>([]);
  const [wds, setWds] = useState<Wd[]>([]);
  const [bal, setBal] = useState<Balances | null>(null);
  // EN: Limits are shown so the user knows the fee and caps BEFORE requesting.
  // ES: Se muestran los límites para que el usuario conozca fee y topes ANTES de pedir.
  const [limits, setLimits] = useState<{ asset: string; perTxMax: string; dailyMax: string; fee: string }[]>([]);
  const [form, setForm] = useState({ asset: 'ETH', to: '', amount: '' });
  const [msg, setMsg] = useState<string | null>(null);

  // EN: Everything on this page is private, so nothing loads without a session.
  // ES: Todo en esta página es privado, así que nada carga sin sesión.
  const load = useCallback(async () => {
    if (!user) return;
    setDeps((await api<{ deposits: Dep[] }>('/account/deposits')).deposits);
    setWds((await api<{ withdrawals: Wd[] }>('/account/withdrawals')).withdrawals);
    setBal((await api<{ balances: Balances }>('/account/balances')).balances);
    setLimits((await api('/account/withdrawal-limits')).limits);
  }, [user]);
  useEffect(() => {
    void load();
  }, [load]);
  // EN: Any private event (deposit credited, withdrawal status change) triggers a reload.
  // ES: Cualquier evento privado (depósito acreditado, cambio de estado de retiro) dispara una recarga.
  useChannels(user ? ['user'] : [], () => void load());

  const showAddress = async () => {
    try {
      setAddr(await api('/account/deposit-address'));
    } catch (e) {
      setAddrErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  };
  // EN: Idempotent POST: the server locks amount+fee into `withdrawing` immediately (no overdraw).
  // ES: POST idempotente: el servidor pasa monto+fee a `withdrawing` de inmediato (sin sobregiro).
  const withdraw = async () => {
    setMsg(null);
    try {
      await api('/account/withdrawals', { method: 'POST', idempotent: true, body: form });
      setMsg('Requested: waiting for 2 admin approvals / Solicitado: esperando 2 aprobaciones');
      setForm({ ...form, amount: '' });
      void load();
    } catch (e) {
      // EN: Shows server codes such as limit_exceeded, insufficient_funds or withdrawals_halted.
      // ES: Muestra códigos del servidor como limit_exceeded, insufficient_funds o withdrawals_halted.
      setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  };
  // EN: DEV only: the API returns 404 when the faucet is disabled (always in production).
  // ES: Solo DEV: la API devuelve 404 si el faucet está deshabilitado (siempre en producción).
  const faucet = async (asset: string, amount: string) => {
    try {
      await api('/dev/faucet', { method: 'POST', body: { asset, amount } });
      void load();
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  };

  // EN: Wait for the session check before deciding what to render.
  // ES: Esperar el chequeo de sesión antes de decidir qué mostrar.
  if (!ready) return null;
  if (!user) return <p>Log in first / Inicia sesión primero.</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-3">
        {/* EN: Left column: balances, deposit address, deposit history. */}
        {/* ES: Columna izquierda: saldos, dirección de depósito, historial de depósitos. */}
        <BalancesPanel balances={bal} />
        <div className="panel space-y-2">
          <h3 className="font-semibold">Deposit / Depositar</h3>
          {/* EN: Address plus the accepted assets and the confirmations required on this chain. */}
          {/* ES: Dirección más los activos aceptados y las confirmaciones requeridas en esta cadena. */}
          {addr ? (
            <>
              <p className="mono break-all text-white">{addr.address}</p>
              <p className="text-xs text-slate-400">
                chainId {addr.chainId} ·{' '}
                {addr.assets.map((a) => `${a.code}${a.contract ? ` (${a.contract.slice(0, 10)}…)` : ''} ${a.confirmations} conf`).join(' · ')}
              </p>
              <p className="text-xs text-amber-300">Testnet only. Send only the listed assets on this chain. / Solo testnet. Envía solo los activos listados en esta red.</p>
            </>
          ) : (
            <button className="btn bg-edge" onClick={() => void showAddress()}>
              Show my address / Ver mi dirección
            </button>
          )}
          {/* EN: e.g. custody not configured on this API instance. */}
          {/* ES: p. ej. custodia no configurada en esta instancia de la API. */}
          {addrErr && <p className="text-ask text-xs">{addrErr}</p>}
          <div className="flex gap-2 text-xs">
            {/* EN: Faucet credits the ledger directly (equity → user); never real funds. */}
            {/* ES: El faucet acredita el ledger directamente (equity → usuario); nunca fondos reales. */}
            <span className="text-slate-500">DEV faucet:</span>
            <button className="underline" onClick={() => void faucet('USDT', '10000')}>
              +10000 USDT
            </button>
            <button className="underline" onClick={() => void faucet('ETH', '5')}>
              +5 ETH
            </button>
            <button className="underline" onClick={() => void faucet('ANX', '10000')}>
              +10000 ANX
            </button>
          </div>
        </div>
        <div className="panel">
          {/* EN: Status goes seen → credited (after N confirmations) or reorged. */}
          {/* ES: El estado pasa de seen → credited (tras N confirmaciones) o reorged. */}
          <h3 className="font-semibold mb-2">Deposits / Depósitos</h3>
          {deps.map((d) => (
            <div key={d.id} className="grid grid-cols-4 text-xs mono">
              <span>{d.asset}</span>
              <span className="text-right">{d.amount}</span>
              <span className="text-right">{d.status}</span>
              <span className="text-right truncate">{d.txHash.slice(0, 12)}…</span>
            </div>
          ))}
          {!deps.length && <p className="text-xs text-slate-500">None / Ninguno</p>}
        </div>
      </div>
      <div className="space-y-3">
        <div className="panel space-y-2">
          {/* EN: Right column: withdrawal form and history. */}
          {/* ES: Columna derecha: formulario e historial de retiros. */}
          <h3 className="font-semibold">Withdraw / Retirar</h3>
          <select className="input" value={form.asset} onChange={(e) => setForm({ ...form, asset: e.target.value })}>
            {['ETH', 'USDT', 'ANX'].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <input className="input mono" placeholder="0x… destination / destino" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value.trim() })} />
          <input className="input mono" placeholder="amount / monto" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.trim() })} />
          {(() => {
            // EN: No limit row = asset not withdrawable (the server enforces the same rule).
            // ES: Sin fila de límite = activo no retirable (el servidor aplica la misma regla).
            const l = limits.find((x) => x.asset === form.asset);
            return (
              <p className="text-xs text-slate-400">
                {l ? `Fee ${l.fee} · per tx ≤ ${l.perTxMax} · 24h ≤ ${l.dailyMax}` : 'Withdrawals disabled for this asset / Retiros deshabilitados para este activo'}
              </p>
            );
          })()}
          {/* EN: Disabled for frozen users; the server would reject anyway (403). */}
          {/* ES: Deshabilitado para usuarios congelados; el servidor rechazaría igual (403). */}
          <button className="btn bg-ask text-white w-full" disabled={!form.to || !form.amount || user.frozen} onClick={() => void withdraw()}>
            Request withdrawal / Solicitar retiro
          </button>
          {msg && <p className="text-xs">{msg}</p>}
        </div>
        <div className="panel">
          {/* EN: pending_approval → approved → broadcast → completed | failed, or rejected (refunded). */}
          {/* ES: pending_approval → approved → broadcast → completed | failed, o rejected (reintegrado). */}
          <h3 className="font-semibold mb-2">Withdrawals / Retiros</h3>
          {wds.map((w) => (
            <div key={w.id} className="grid grid-cols-4 text-xs mono">
              <span>{w.asset}</span>
              <span className="text-right">{w.amount}</span>
              <span className="text-right">{w.status}</span>
              <span className="text-right truncate">{w.txHash ? w.txHash.slice(0, 12) + '…' : '—'}</span>
            </div>
          ))}
          {!wds.length && <p className="text-xs text-slate-500">None / Ninguno</p>}
        </div>
      </div>
    </div>
  );
}
