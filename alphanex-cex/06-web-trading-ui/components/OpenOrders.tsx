'use client';
// EN: User's open orders with cancel buttons. / ES: Órdenes abiertas del usuario con botón de cancelar.
import { api, type Order } from '@/lib/api';

export function OpenOrders({ orders, onChange }: { orders: Order[]; onChange: () => void }) {
  // EN: Cancel one order; errors (already filled) are ignored and the list is refreshed.
  // ES: Cancelar una orden; los errores (ya ejecutada) se ignoran y se refresca la lista.
  const cancel = async (id: string) => {
    await api(`/orders/${id}`, { method: 'DELETE' }).catch(() => undefined);
    onChange();
  };
  return (
    <div className="panel">
      <div className="flex mb-2">
        <h3 className="font-semibold">Open orders / Órdenes abiertas</h3>
        {/* EN: Cancel-all hits DELETE /orders, which releases every locked amount. */}
        {/* ES: Cancelar todas llama DELETE /orders, que libera todos los montos bloqueados. */}
        {orders.length > 0 && (
          <button className="ml-auto text-xs text-ask" onClick={() => void api('/orders', { method: 'DELETE' }).then(onChange)}>
            Cancel all / Cancelar todas
          </button>
        )}
      </div>
      <table className="w-full text-xs mono">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left">Market</th>
            <th className="text-left">Side</th>
            <th className="text-right">Price</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Filled</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {/* EN: One row per open order with its fill progress. */}
          {/* ES: Una fila por orden abierta con su avance de ejecución. */}
          {orders.map((o) => (
            <tr key={o.id}>
              <td>{o.market}</td>
              <td className={o.side === 'buy' ? 'text-bid' : 'text-ask'}>{o.side}</td>
              <td className="text-right">{o.price}</td>
              <td className="text-right">{o.qty}</td>
              <td className="text-right">{o.filled}</td>
              <td className="text-right">
                <button className="text-ask" onClick={() => void cancel(o.id)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* EN: Empty state. */}
      {/* ES: Estado vacío. */}
      {!orders.length && <p className="text-slate-500 text-xs">None / Ninguna</p>}
    </div>
  );
}
