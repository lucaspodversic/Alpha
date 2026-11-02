'use client';
/**
 * EN: Ops console: kill switches (user / market freeze), four-eyes withdrawal queue, limits,
 *     invariants, reconciliation and audit-chain verification. Every action is audited server-side.
 * ES: Consola de ops: interruptores (congelar usuario / mercado), cola de retiros de cuatro ojos,
 *     límites, invariantes, conciliación y verificación de la cadena de auditoría. Todo queda auditado en el servidor.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Market, type User } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useChannels } from '@/lib/ws';

// EN: Withdrawal row as returned by GET /admin/withdrawals.
// ES: Fila de retiro tal como la devuelve GET /admin/withdrawals.
interface Wd {
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
}
// EN: Audit entry (hash fields omitted in the UI; use “Verify audit chain”).
// ES: Entrada de auditoría (los hashes se omiten en la UI; usar “Verify audit chain”).
interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
}

export default function AdminPage() {
  // EN: The UI hides admin pages from non-admins, but the REAL check is server-side (403).
  // ES: La UI oculta las páginas admin a no-admins, pero el chequeo REAL está en el servidor (403).
  const { user, ready } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [wds, setWds] = useState<Wd[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [report, setReport] = useState<string>('');
  const [alerts, setAlerts] = useState<string[]>([]);
  const [limit, setLimit] = useState({ asset: 'ETH', perTxMax: '', dailyMax: '', fee: '' });
  // EN: Global withdrawal kill switch state (set by an admin or automatically by a reconciliation deficit).
  // ES: Estado del interruptor global de retiros (lo pone un admin o automáticamente un déficit de conciliación).
  const [halt, setHalt] = useState<{ halted: boolean; reason: string | null }>({ halted: false, reason: null });

  // EN: Reload everything after each action so the console never shows stale state.
  // ES: Recargar todo después de cada acción para que la consola nunca muestre estado viejo.
  const load = useCallback(async () => {
    setUsers((await api('/admin/users')).users);
    setMarkets((await api('/markets')).markets);
    setWds((await api('/admin/withdrawals')).withdrawals);
    setAudit((await api('/admin/audit?limit=30')).entries);
    setHalt(await api('/admin/withdrawals/halt'));
  }, []);
  useEffect(() => {
    if (user?.role === 'admin') void load();
  }, [user, load]);
  // EN: Live alerts (critical reorgs, reconciliation deficits, halts) pushed on the `admin` channel.
  // ES: Alertas en vivo (reorgs críticos, déficits de conciliación, halts) enviadas por el canal `admin`.
  useChannels(user?.role === 'admin' ? ['admin'] : [], (_c, d) => setAlerts((a) => [JSON.stringify(d).slice(0, 300), ...a].slice(0, 20)));

  // EN: Wrap every action: ask for a reason where required, show errors, refresh. / ES: Envolver acciones: pedir motivo si hace falta, mostrar errores, refrescar.
  const act = async (fn: () => Promise<unknown>, label: string) => {
    try {
      const r = await fn();
      setReport(`${label}: ${JSON.stringify(r, null, 2)}`);
    } catch (e) {
      setReport(`${label} failed: ${e instanceof ApiError ? `${e.code} ${e.message}` : String(e)}`);
    }
    void load();
  };
  // EN: Sensitive actions require a human-typed reason; it ends up in the audit log.
  // ES: Las acciones sensibles exigen un motivo escrito por una persona; queda en la auditoría.
  const reason = (q: string) => window.prompt(`${q}\nReason / Motivo (required):`)?.trim();

  // EN: Wait for the session check before deciding what to render.
  // ES: Esperar el chequeo de sesión antes de decidir qué mostrar.
  if (!ready) return null;
  if (user?.role !== 'admin') return <p>Admins only / Solo admins.</p>;
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <section className="panel space-y-2">
        {/* EN: Health checks: ledger/book invariants, on-chain reconciliation, audit hash chain, pending receipts. */}
        {/* ES: Chequeos de salud: invariantes ledger/libro, conciliación on-chain, cadena de hashes de auditoría, recibos pendientes. */}
        <h3 className="font-semibold">Health / Salud</h3>
        <div className="flex gap-2 flex-wrap">
          <button className="btn bg-edge" onClick={() => void act(() => api('/admin/invariants'), 'invariants')}>
            Check invariants
          </button>
          <button className="btn bg-edge" onClick={() => void act(() => api('/admin/reconcile', { method: 'POST' }), 'reconcile')}>
            Reconcile on-chain
          </button>
          <button className="btn bg-edge" onClick={() => void act(() => api('/admin/audit/verify'), 'audit verify')}>
            Verify audit chain
          </button>
          <button className="btn bg-edge" onClick={() => void act(() => api('/admin/withdrawals/confirm', { method: 'POST' }), 'confirm broadcasts')}>
            Confirm broadcasts
          </button>
        </div>
        <pre className="text-xs bg-black/40 p-2 rounded max-h-64 overflow-auto whitespace-pre-wrap">{report || '—'}</pre>
        {/* EN: Most recent alerts first (max 20 kept in memory). */}
        {/* ES: Alertas más recientes primero (se guardan hasta 20 en memoria). */}
        {alerts.length > 0 && (
          <div className="text-xs text-ask space-y-1">
            {alerts.map((a, i) => (
              <p key={i}>⚠ {a}</p>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        {/* EN: Freezing a market rejects new orders; existing orders stay until canceled. */}
        {/* ES: Congelar un mercado rechaza órdenes nuevas; las existentes quedan hasta cancelarse. */}
        <h3 className="font-semibold mb-2">Markets (kill switch) / Mercados</h3>
        {markets.map((m) => (
          <div key={m.id} className="flex items-center gap-2 text-xs py-1">
            <span className="mono w-24">{m.id}</span>
            <span className={m.frozen ? 'text-ask' : 'text-bid'}>{m.frozen ? 'FROZEN' : 'live'}</span>
            <button
              className="ml-auto btn bg-edge"
              onClick={() => {
                const r = reason(`${m.frozen ? 'Unfreeze' : 'Freeze'} ${m.id}?`);
                if (r) void act(() => api(`/admin/markets/${m.id}/freeze`, { method: 'POST', body: { frozen: !m.frozen, reason: r } }), 'market freeze');
              }}
            >
              {m.frozen ? 'Unfreeze' : 'Freeze'}
            </button>
          </div>
        ))}
      </section>

      <section className="panel xl:col-span-2">
        {/* EN: Four-eyes queue: approve → (2nd admin) approve → sign+send. The server enforces every rule again. */}
        {/* ES: Cola de cuatro ojos: aprobar → (2º admin) aprobar → firmar+enviar. El servidor vuelve a validar cada regla. */}
        <h3 className="font-semibold mb-2">Withdrawals (2 approvals) / Retiros (2 aprobaciones)</h3>
        {/* EN: Kill switch: halting stops new requests and signing; approvals/rejections still work. */}
        {/* ES: Interruptor: detener frena pedidos nuevos y firmas; aprobar/rechazar sigue funcionando. */}
        <div className="flex items-center gap-2 text-xs mb-2">
          <span className={halt.halted ? 'text-ask' : 'text-bid'}>
            {halt.halted ? `HALTED — ${halt.reason ?? ''}` : 'Withdrawals running / Retiros activos'}
          </span>
          <button
            className="ml-auto btn bg-edge"
            onClick={() => {
              const r = reason(halt.halted ? 'Resume ALL withdrawals?' : 'Halt ALL withdrawals?');
              if (r) void act(() => api('/admin/withdrawals/halt', { method: 'POST', body: { halted: !halt.halted, reason: r } }), 'withdrawals halt');
            }}
          >
            {halt.halted ? 'Resume' : 'Halt all'}
          </button>
        </div>
        <table className="w-full text-xs mono">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left">Asset</th>
              <th className="text-right">Amount</th>
              <th className="text-left pl-2">To</th>
              <th>Status</th>
              <th>Approvals</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wds.map((w) => (
              <tr key={w.id} className="border-t border-edge">
                <td>{w.asset}</td>
                <td className="text-right">{w.amount}</td>
                <td className="pl-2 truncate max-w-[160px]">{w.to}</td>
                <td className="text-center">
                  {w.status}
                  {w.error ? ` (${w.error})` : ''}
                </td>
                <td className="text-center">{w.approvals.length}/2</td>
                <td className="text-right space-x-2">
                  {/* EN: Buttons depend on the state machine; the server rejects invalid transitions anyway (409). */}
                  {/* ES: Los botones dependen de la máquina de estados; el servidor rechaza transiciones inválidas igual (409). */}
                  {w.status === 'pending_approval' && (
                    <button className="text-bid" onClick={() => void act(() => api(`/admin/withdrawals/${w.id}/approve`, { method: 'POST' }), 'approve')}>
                      approve
                    </button>
                  )}
                  {/* EN: Explicit confirm dialog before anything is signed: real value would leave the hot wallet. */}
                  {/* ES: Diálogo de confirmación explícito antes de firmar: saldría valor real de la hot wallet. */}
                  {w.status === 'approved' && (
                    <button
                      className="text-amber-300"
                      onClick={() => window.confirm(`Sign & broadcast ${w.amount} ${w.asset} to ${w.to}?`) && void act(() => api(`/admin/withdrawals/${w.id}/process`, { method: 'POST' }), 'process')}
                    >
                      sign+send
                    </button>
                  )}
                  {/* EN: Reject (= refund) is never offered once broadcast: the payout may already be on-chain. */}
                  {/* ES: Rechazar (= reintegrar) nunca se ofrece una vez difundido: el pago puede estar ya on-chain. */}
                  {['pending_approval', 'approved', 'failed'].includes(w.status) && (
                    <button
                      className="text-ask"
                      onClick={() => {
                        const r = reason('Reject and refund?');
                        if (r) void act(() => api(`/admin/withdrawals/${w.id}/reject`, { method: 'POST', body: { reason: r } }), 'reject');
                      }}
                    >
                      reject
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        {/* EN: Freezing a user cancels all their open orders and blocks orders and withdrawals. */}
        {/* ES: Congelar a un usuario cancela todas sus órdenes abiertas y bloquea órdenes y retiros. */}
        <h3 className="font-semibold mb-2">Users / Usuarios</h3>
        <div className="max-h-72 overflow-auto">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-2 text-xs py-1">
              <span className="truncate">{u.email}</span>
              <span className="text-slate-500">{u.role}</span>
              {u.frozen && <span className="text-ask">FROZEN</span>}
              <button
                className="ml-auto btn bg-edge"
                onClick={() => {
                  const r = reason(`${u.frozen ? 'Unfreeze' : 'Freeze'} ${u.email}?`);
                  if (r) void act(() => api(`/admin/users/${u.id}/freeze`, { method: 'POST', body: { frozen: !u.frozen, reason: r } }), 'user freeze');
                }}
              >
                {u.frozen ? 'Unfreeze' : 'Freeze'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel space-y-2">
        {/* EN: Human-readable decimals; the API converts them to base units and audits the change. */}
        {/* ES: Decimales legibles; la API los convierte a unidades base y audita el cambio. */}
        <h3 className="font-semibold">Withdrawal limits / Límites de retiro</h3>
        <div className="grid grid-cols-4 gap-1">
          <select className="input" value={limit.asset} onChange={(e) => setLimit({ ...limit, asset: e.target.value })}>
            {['ETH', 'USDT', 'ANX'].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <input className="input" placeholder="per tx" value={limit.perTxMax} onChange={(e) => setLimit({ ...limit, perTxMax: e.target.value })} />
          <input className="input" placeholder="daily" value={limit.dailyMax} onChange={(e) => setLimit({ ...limit, dailyMax: e.target.value })} />
          <input className="input" placeholder="fee" value={limit.fee} onChange={(e) => setLimit({ ...limit, fee: e.target.value })} />
        </div>
        <button
          className="btn bg-edge"
          onClick={() => void act(() => api(`/admin/limits/${limit.asset}`, { method: 'PUT', body: { perTxMax: limit.perTxMax, dailyMax: limit.dailyMax, fee: limit.fee } }), 'limits')}
        >
          Save limits
        </button>
      </section>

      <section className="panel xl:col-span-2">
        {/* EN: Read-only view of the last 30 entries (the log itself can never be edited). */}
        {/* ES: Vista de solo lectura de las últimas 30 entradas (el log en sí nunca se puede editar). */}
        <h3 className="font-semibold mb-2">Audit log (latest) / Auditoría (últimos)</h3>
        <div className="max-h-72 overflow-auto text-xs mono">
          {audit.map((a) => (
            <div key={a.seq} className="grid grid-cols-[50px_180px_200px_1fr] gap-2">
              <span>#{a.seq}</span>
              <span className="text-slate-500">{new Date(a.at).toLocaleString()}</span>
              <span>{a.action}</span>
              <span className="truncate text-slate-400">
                {a.actor} → {a.target ?? '—'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
