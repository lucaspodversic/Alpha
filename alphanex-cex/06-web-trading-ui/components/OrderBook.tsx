'use client';
/**
 * EN: Depth view with cumulative bars; clicking a level fills the price in the order form.
 * ES: Vista de profundidad con barras acumuladas; clic en un nivel completa el precio en el formulario.
 */
import type { Book } from '@/lib/api';
import { spread } from '@/lib/decimal';

export function OrderBook({ book, onPick }: { book: Book | null; onPick: (price: string) => void }) {
  // EN: Top 15 levels per side; asks reversed so the best ask sits right above the spread.
  // ES: Top 15 niveles por lado; asks invertidos para que el mejor ask quede justo encima del spread.
  const asks = (book?.asks ?? []).slice(0, 15).reverse();
  const bids = (book?.bids ?? []).slice(0, 15);
  // EN: Bar width from qty relative to the largest level (display only, float is fine).
  // ES: Ancho de barra por qty relativa al nivel mayor (solo visual, float está bien).
  const max = Math.max(1e-18, ...[...asks, ...bids].map((l) => Number(l.qty)));
  // EN: Spread computed with exact decimal math (lib/decimal).
  // ES: Spread calculado con aritmética decimal exacta (lib/decimal).
  const sp = spread(book?.bids[0]?.price, book?.asks[0]?.price);
  // EN: A clickable level: background bar + price + qty.
  // ES: Un nivel clicable: barra de fondo + precio + cantidad.
  const Row = ({ price, qty, side }: { price: string; qty: string; side: 'bid' | 'ask' }) => (
    <button onClick={() => onPick(price)} className="relative w-full grid grid-cols-2 px-1 mono text-right hover:bg-edge">
      <span className={`absolute inset-y-0 right-0 ${side === 'bid' ? 'bg-bid/10' : 'bg-ask/10'}`} style={{ width: `${(Number(qty) / max) * 100}%` }} />
      <span className={`relative text-left ${side === 'bid' ? 'text-bid' : 'text-ask'}`}>{price}</span>
      <span className="relative">{qty}</span>
    </button>
  );
  return (
    <div className="panel">
      <h3 className="font-semibold mb-2">Order book / Libro</h3>
      <div className="grid grid-cols-2 px-1 text-xs text-slate-500">
        <span>Price / Precio</span>
        <span className="text-right">Qty / Cant.</span>
      </div>
      {/* EN: Asks (sell side), spread line, then bids (buy side). */}
      {/* ES: Asks (lado venta), línea de spread y luego bids (lado compra). */}
      {asks.map((l) => (
        <Row key={'a' + l.price} {...l} side="ask" />
      ))}
      {/* EN: Spread between best bid and best ask (absolute and in basis points). */}
      {/* ES: Spread entre mejor bid y mejor ask (absoluto y en puntos básicos). */}
      <div className="text-center text-xs text-slate-400 py-1 mono">{sp ? `spread ${sp.abs} (${sp.bps} bps)` : '—'}</div>
      {bids.map((l) => (
        <Row key={'b' + l.price} {...l} side="bid" />
      ))}
    </div>
  );
}
