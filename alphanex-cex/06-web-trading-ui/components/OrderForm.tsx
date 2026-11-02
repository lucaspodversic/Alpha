'use client';
/**
 * EN: Buy/sell form (limit or market). Validates locally, then POSTs with an Idempotency-Key so a
 *     double click or network retry can never place the order twice.
 * ES: Formulario de compra/venta (límite o mercado). Valida localmente y luego hace POST con
 *     Idempotency-Key para que un doble clic o reintento de red nunca coloque la orden dos veces.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type Balances, type Market } from '@/lib/api';
import { mulDec, validateOrder, DECIMAL_RE } from '@/lib/decimal';

// EN: Props: market config, current balances, a price picked from the book, and a callback after placing.
// ES: Props: config del mercado, saldos actuales, un precio elegido del libro y un callback tras colocar.
export function OrderForm({ market, balances, pickedPrice, onPlaced }: { market: Market; balances: Balances | null; pickedPrice: string; onPlaced: () => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'limit' | 'market'>('limit');
  // EN: Supported TIFs: GTC, IOC, POST_ONLY (FOK is out of the MVP scope).
  // ES: TIFs soportados: GTC, IOC, POST_ONLY (FOK queda fuera del alcance del MVP).
  const [tif, setTif] = useState<'GTC' | 'IOC' | 'POST_ONLY'>('GTC');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // EN: `busy` disables the button while a request is in flight.
  // ES: `busy` deshabilita el botón mientras hay un pedido en curso.
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pickedPrice) setPrice(pickedPrice);
  }, [pickedPrice]);

  // EN: Only `available` can be spent; `locked` already backs other open orders.
  // ES: Solo `available` se puede gastar; `locked` ya respalda otras órdenes abiertas.
  const avail = { base: balances?.[market.base]?.available ?? '0', quote: balances?.[market.quote]?.available ?? '0' };
  // EN: Local validation (tick, lot, min qty, funds) is UX only; the server re-validates everything.
  // ES: La validación local (tick, lote, cantidad mínima, fondos) es solo UX; el servidor revalida todo.
  const localError = qty ? validateOrder({ side, type, price, qty }, market, avail) : null;
  // EN: Exact decimal multiplication (string math), never floats.
  // ES: Multiplicación decimal exacta (aritmética de strings), nunca floats.
  const total = type === 'limit' && DECIMAL_RE.test(price) && DECIMAL_RE.test(qty) ? mulDec(price, qty) : null;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ order: { status: string; filled: string } }>('/orders', {
        method: 'POST',
        idempotent: true,
        // EN: Market orders send no price/TIF: the engine treats them as IOC.
        // ES: Las órdenes de mercado no envían precio/TIF: el motor las trata como IOC.
        body: { market: market.id, side, type, qty, ...(type === 'limit' ? { price, tif } : {}) },
      });
      // EN: e.g. POST_ONLY that would cross, or STP: the order comes back `rejected`/`expired`.
      // ES: p. ej. POST_ONLY que cruzaría, o STP: la orden vuelve `rejected`/`expired`.
      setMsg({ ok: r.order.status !== 'rejected', text: `${r.order.status} (filled ${r.order.filled})` });
      onPlaced();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? `${e.code}: ${e.message}` : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel space-y-2">
      {/* EN: Side toggle. */}
      {/* ES: Selector de lado. */}
      <div className="grid grid-cols-2 gap-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button key={s} onClick={() => setSide(s)} className={`btn ${side === s ? (s === 'buy' ? 'bg-bid text-black' : 'bg-ask text-white') : 'bg-edge'}`}>
            {s === 'buy' ? 'Buy / Comprar' : 'Sell / Vender'}
          </button>
        ))}
      </div>
      {/* EN: Order type and time-in-force (TIF only for limit orders). */}
      {/* ES: Tipo de orden y vigencia (TIF solo para órdenes límite). */}
      <div className="flex gap-2 text-xs">
        {(['limit', 'market'] as const).map((t) => (
          <button key={t} onClick={() => setType(t)} className={type === t ? 'text-white underline' : 'text-slate-400'}>
            {t}
          </button>
        ))}
        {type === 'limit' && (
          <select className="ml-auto bg-transparent" value={tif} onChange={(e) => setTif(e.target.value as typeof tif)}>
            <option>GTC</option>
            <option>IOC</option>
            <option>POST_ONLY</option>
          </select>
        )}
      </div>
      {type === 'limit' && (
        <label className="block">
          <span className="text-xs text-slate-400">Price / Precio ({market.quote})</span>
          <input className="input mono" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.trim())} />
        </label>
      )}
      <label className="block">
        <span className="text-xs text-slate-400">Qty / Cantidad ({market.base})</span>
        <input className="input mono" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.trim())} />
      </label>
      {/* EN: Buy spends the quote asset, sell spends the base asset. */}
      {/* ES: Comprar gasta el activo cotizado, vender gasta el activo base. */}
      <p className="text-xs text-slate-400 mono">
        Avail / Disp.: {side === 'buy' ? `${avail.quote} ${market.quote}` : `${avail.base} ${market.base}`}
        {total && ` · Total ≈ ${total} ${market.quote}`}
      </p>
      <p className="text-xs text-slate-500">
        Fees: maker {market.makerFeeBps / 100}% · taker {market.takerFeeBps / 100}%
      </p>
      {localError && <p className="text-xs text-amber-400">{localError}</p>}
      {/* EN: Never submit while busy, invalid, or when the market is frozen. */}
      {/* ES: Nunca enviar si está ocupado, es inválido o el mercado está congelado. */}
      <button disabled={busy || !qty || !!localError || market.frozen} onClick={() => void submit()} className={`btn w-full ${side === 'buy' ? 'bg-bid text-black' : 'bg-ask text-white'}`}>
        {market.frozen ? 'Market frozen / Mercado congelado' : `${side.toUpperCase()} ${market.base}`}
      </button>
      {msg && <p className={`text-xs ${msg.ok ? 'text-bid' : 'text-ask'}`}>{msg.text}</p>}
    </div>
  );
}
