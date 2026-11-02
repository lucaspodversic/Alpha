'use client';
// EN: Recent public trades. / ES: Trades públicos recientes.
import type { Trade } from '@/lib/api';

// EN: Color = taker side (green buy, red sell); time in the browser's locale.
// ES: Color = lado del taker (verde compra, rojo venta); hora en el idioma del navegador.
export function Trades({ trades }: { trades: Trade[] }) {
  return (
    <div className="panel">
      <h3 className="font-semibold mb-2">Trades</h3>
      <div className="max-h-80 overflow-auto">
        {trades.map((t) => (
          <div key={t.id} className="grid grid-cols-3 mono text-xs">
            <span className={t.side === 'buy' ? 'text-bid' : 'text-ask'}>{t.price}</span>
            <span className="text-right">{t.qty}</span>
            <span className="text-right text-slate-500">{new Date(t.at).toLocaleTimeString()}</span>
          </div>
        ))}
        {/* EN: Empty state. */}
        {/* ES: Estado vacío. */}
        {!trades.length && <p className="text-slate-500">No trades yet / Sin trades aún</p>}
      </div>
    </div>
  );
}
