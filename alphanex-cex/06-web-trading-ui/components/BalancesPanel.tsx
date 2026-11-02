'use client';
// EN: Balances table (available / locked in orders / pending withdrawal). / ES: Tabla de saldos (disponible / bloqueado en órdenes / retiro pendiente).
import type { Balances } from '@/lib/api';

// EN: Pure presentational component; values are decimal strings straight from the ledger.
// ES: Componente puramente visual; los valores son strings decimales directos del ledger.
export function BalancesPanel({ balances }: { balances: Balances | null }) {
  return (
    <div className="panel">
      <h3 className="font-semibold mb-2">Balances / Saldos</h3>
      {/* EN: available + locked + withdrawing = total owed to the user for that asset. */}
      {/* ES: available + locked + withdrawing = total adeudado al usuario en ese activo. */}
      <table className="w-full text-xs mono">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left">Asset</th>
            <th className="text-right">Available</th>
            <th className="text-right">Locked</th>
            <th className="text-right">Withdrawing</th>
          </tr>
        </thead>
        <tbody>
          {/* EN: One row per asset; null balances (still loading) render an empty table. */}
          {/* ES: Una fila por activo; saldos null (cargando) muestran una tabla vacía. */}
          {Object.entries(balances ?? {}).map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td className="text-right">{b.available}</td>
              <td className="text-right">{b.locked}</td>
              <td className="text-right">{b.withdrawing}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
