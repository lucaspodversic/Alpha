'use client';
/**
 * EN: Trading screen wired to the real API: REST for initial state, WebSocket for live book/trades
 *     and private order/balance updates.
 * ES: Pantalla de trading conectada a la API real: REST para el estado inicial, WebSocket para
 *     libro/trades en vivo y actualizaciones privadas de órdenes/saldos.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type Balances, type Book, type Candle, type Market, type Order, type Trade } from '@/lib/api';
import { useChannels } from '@/lib/ws';
import { useSession } from '@/lib/session';
import { OrderBook } from '@/components/OrderBook';
import { Trades } from '@/components/Trades';
import { Chart } from '@/components/Chart';
import { OrderForm } from '@/components/OrderForm';
import { OpenOrders } from '@/components/OpenOrders';
import { BalancesPanel } from '@/components/BalancesPanel';

// EN: Route /trade/[market], e.g. /trade/ETH-USDT.
// ES: Ruta /trade/[market], p. ej. /trade/ETH-USDT.
export default function TradePage({ params }: { params: { market: string } }) {
  // EN: Normalize the URL segment to the market id format used by the API.
  // ES: Normalizar el segmento de URL al formato de id de mercado de la API.
  const id = decodeURIComponent(params.market).toUpperCase();
  const { user } = useSession();
  const [market, setMarket] = useState<Market | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ticker, setTicker] = useState<{ last: string | null; high24h: string | null; low24h: string | null; volume24h: string } | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  // EN: Price clicked in the order book, copied into the order form.
  // ES: Precio clicado en el libro, copiado al formulario de órdenes.
  const [picked, setPicked] = useState('');
  const [error, setError] = useState<string | null>(null);

  // EN: Public data. / ES: Datos públicos.
  const loadPublic = useCallback(async () => {
    try {
      const ms = await api<{ markets: Market[] }>('/markets');
      setMarket(ms.markets.find((m) => m.id === id) ?? null);
      setBook(await api<Book>(`/markets/${id}/book`));
      setTrades((await api<{ trades: Trade[] }>(`/markets/${id}/trades`)).trades);
      setCandles((await api<{ candles: Candle[] }>(`/markets/${id}/candles?interval=60`)).candles);
      setTicker(await api(`/markets/${id}/ticker`));
      // EN: Clear a previous connection error once the API answers again.
      // ES: Limpiar un error de conexión previo cuando la API vuelve a responder.
      setError(null);
    } catch (e) {
      setError(`API unreachable / API no disponible: ${(e as Error).message}`);
    }
  }, [id]);
  // EN: Private data. / ES: Datos privados.
  const loadPrivate = useCallback(async () => {
    if (!user) return;
    setOrders((await api<{ orders: Order[] }>('/orders?open=true')).orders);
    setBalances((await api<{ balances: Balances }>('/account/balances')).balances);
  }, [user]);

  // EN: Initial REST load; afterwards the WebSocket keeps the screen live.
  // ES: Carga REST inicial; después el WebSocket mantiene la pantalla en vivo.
  useEffect(() => {
    void loadPublic();
  }, [loadPublic]);
  useEffect(() => {
    void loadPrivate();
  }, [loadPrivate]);

  // EN: Public channels for everyone, plus the private `user` channel when logged in.
  // ES: Canales públicos para todos, más el canal privado `user` con sesión iniciada.
  useChannels(user ? [`book:${id}`, `trades:${id}`, 'user'] : [`book:${id}`, `trades:${id}`], (ch, data) => {
    // EN: The book event is a full snapshot (top levels), so it simply replaces the state.
    // ES: El evento del libro es un snapshot completo (niveles top), así que reemplaza el estado.
    if (ch === `book:${id}`) setBook(data as Book);
    else if (ch === `trades:${id}`) {
      // EN: Prepend the new trade, de-duplicate by id, keep the last 100.
      // ES: Agregar el trade nuevo al inicio, deduplicar por id, conservar los últimos 100.
      setTrades((t) => [data as Trade, ...t.filter((x) => x.id !== (data as Trade).id)].slice(0, 100));
      void api(`/markets/${id}/ticker`).then(setTicker);
      void api<{ candles: Candle[] }>(`/markets/${id}/candles?interval=60`).then((r) => setCandles(r.candles));
    // EN: Fills, cancels and balance changes: refetch the authoritative state.
    // ES: Ejecuciones, cancelaciones y cambios de saldo: volver a pedir el estado autoritativo.
    } else if (ch === 'user') void loadPrivate();
  });

  // EN: Explicit message instead of a blank page when the API is down.
  // ES: Mensaje explícito en vez de página vacía si la API está caída.
  if (error) return <p className="text-ask">{error}</p>;
  if (!market) return <p className="text-slate-400">Loading / Cargando…</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_320px_300px]">
      <div className="space-y-3">
        {/* EN: Ticker bar: last price and 24h stats. */}
        {/* ES: Barra de ticker: último precio y estadísticas de 24 h. */}
        <div className="panel flex gap-6 items-baseline mono">
          <span className="text-lg font-bold">
            {market.base}/{market.quote}
          </span>
          <span>Last {ticker?.last ?? '—'}</span>
          <span className="text-slate-400">24h H {ticker?.high24h ?? '—'}</span>
          <span className="text-slate-400">L {ticker?.low24h ?? '—'}</span>
          <span className="text-slate-400">Vol {ticker?.volume24h ?? '0'}</span>
          {market.frozen && <span className="text-ask">FROZEN</span>}
        </div>
        <Chart candles={candles} />
        {user ? <OpenOrders orders={orders} onChange={() => void loadPrivate()} /> : null}
      </div>
      {/* EN: Middle column: order book (click a level to pick its price). */}
      {/* ES: Columna central: libro de órdenes (clic en un nivel para tomar su precio). */}
      <OrderBook book={book} onPick={setPicked} />
      <div className="space-y-3">
        {/* EN: Right column: order form + balances when logged in, recent trades always. */}
        {/* ES: Columna derecha: formulario + saldos con sesión, trades recientes siempre. */}
        {user ? (
          <>
            <OrderForm market={market} balances={balances} pickedPrice={picked} onPlaced={() => void loadPrivate()} />
            <BalancesPanel balances={balances} />
          </>
        ) : (
          <div className="panel">
            <Link href="/login" className="underline">
              Log in to trade / Inicia sesión para operar
            </Link>
          </div>
        )}
        <Trades trades={trades} />
      </div>
    </div>
  );
}
