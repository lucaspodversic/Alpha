// EN: End-to-end spot trading over HTTP: holds, fills, fees, cancel, idempotency, freezes, WS, restart.
// ES: Trading spot end-to-end por HTTP: holds, fills, fees, cancelación, idempotencia, congelamientos, WS, reinicio.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, call, user, balances, PW } from './helpers.js';

let h: Awaited<ReturnType<typeof makeApp>>;
let alice: { token: string; id: string };
let bob: { token: string; id: string };
let admin: { token: string; id: string };

beforeAll(async () => {
  h = await makeApp({}, { bootstrapAdmins: [{ email: 'root@example.com', password: PW }] });
  alice = await user(h.app, 'alice@example.com');
  bob = await user(h.app, 'bob@example.com');
  const l = await call(h.app, 'POST', '/auth/login', { body: { email: 'root@example.com', password: PW } });
  admin = { token: l.json.token, id: l.json.user.id };
  await call(h.app, 'POST', '/dev/faucet', { token: alice.token, body: { asset: 'ETH', amount: '2' } });
  await call(h.app, 'POST', '/dev/faucet', { token: bob.token, body: { asset: 'USDT', amount: '5000' } });
});
afterAll(async () => {
  await h.app.close();
  await h.db.close();
});

// EN: Helper: global ledger + book + hold invariants, checked after every scenario.
// ES: Helper: invariantes globales de ledger + libro + retenciones, verificados tras cada escenario.
const invariantsOk = async () => (await call(h.app, 'GET', '/admin/invariants', { token: admin.token })).json;

describe('spot trading', () => {
  it('lists the two markets / lista los dos mercados', async () => {
    const r = await call(h.app, 'GET', '/markets');
    expect(r.json.markets.map((m: { id: string }) => m.id).sort()).toEqual(['ANX-USDT', 'ETH-USDT']);
  });

  it('limit order locks funds; crossing order fills at maker price with fees / la orden límite bloquea fondos; la que cruza llena al precio maker con fees', async () => {
    const sell = await call(h.app, 'POST', '/orders', { token: alice.token, body: { market: 'ETH-USDT', side: 'sell', type: 'limit', price: '2000', qty: '1' } });
    expect(sell.status).toBe(201);
    expect(sell.json.order.status).toBe('open');
    // EN: Resting sell locks exactly the base quantity.
    // ES: La venta en el libro bloquea exactamente la cantidad base.
    expect((await balances(h.app, alice.token)).ETH).toEqual({ available: '1', locked: '1', withdrawing: '0' });

    const buy = await call(h.app, 'POST', '/orders', { token: bob.token, body: { market: 'ETH-USDT', side: 'buy', type: 'limit', price: '2100', qty: '0.4' } });
    expect(buy.json.order.status).toBe('filled');
    // EN: Executed at the MAKER price (2000), not the taker's limit.
    // ES: Ejecutado al precio del MAKER (2000), no al límite del taker.
    expect(buy.json.order.filledQuote).toBe('800');
    // EN: Bob: 0.4 ETH − 0.2% taker fee; the 40 USDT price improvement is released.
    // ES: Bob: 0,4 ETH − 0,2% fee taker; se libera la mejora de precio de 40 USDT.
    const b = await balances(h.app, bob.token);
    // EN: Buyer pays the fee in base: 0.4 − 0.2% = 0.3992 ETH; the unused quote hold is released.
    // ES: El comprador paga la fee en base: 0.4 − 0.2% = 0.3992 ETH; se libera la retención de quote no usada.
    expect(b.ETH.available).toBe('0.3992');
    expect(b.USDT).toEqual({ available: '4200', locked: '0', withdrawing: '0' });
    // EN: Alice: 800 USDT − 0.1% maker fee; 0.6 ETH still locked. / ES: Alice: 800 USDT − 0,1% fee maker; 0,6 ETH sigue bloqueado.
    const a = await balances(h.app, alice.token);
    // EN: Seller pays the fee in quote: 800 − 0.1% maker fee = 799.2 USDT.
    // ES: El vendedor paga la fee en quote: 800 − 0.1% fee maker = 799.2 USDT.
    expect(a.USDT.available).toBe('799.2');
    expect(a.ETH).toEqual({ available: '1', locked: '0.6', withdrawing: '0' });

    const book = await call(h.app, 'GET', '/markets/ETH-USDT/book');
    expect(book.json.asks[0]).toMatchObject({ price: '2000', qty: '0.6' });
    expect((await call(h.app, 'GET', '/markets/ETH-USDT/trades')).json.trades).toHaveLength(1);
    // EN: Candles and ticker reflect the trade. / ES: Velas y ticker reflejan el trade.
    const candles = (await call(h.app, 'GET', '/markets/ETH-USDT/candles?interval=60')).json.candles;
    expect(candles.at(-1)).toMatchObject({ open: '2000', close: '2000', volume: '0.4' });
    expect((await call(h.app, 'GET', '/markets/ETH-USDT/ticker')).json).toMatchObject({ last: '2000', bestAsk: '2000' });
    expect((await invariantsOk()).ok).toBe(true);
  });

  it('market buy, cancel and validation errors / compra a mercado, cancelación y errores de validación', async () => {
    const mkt = await call(h.app, 'POST', '/orders', { token: bob.token, body: { market: 'ETH-USDT', side: 'buy', type: 'market', qty: '0.1' } });
    expect(mkt.json.order.status).toBe('filled');
    // EN: POST_ONLY that would cross is rejected without side effects. / ES: POST_ONLY que cruzaría se rechaza sin efectos.
    // EN: POST_ONLY that would cross is rejected and its hold fully released.
    // ES: Un POST_ONLY que cruzaría se rechaza y su retención se libera por completo.
    const po = await call(h.app, 'POST', '/orders', { token: bob.token, body: { market: 'ETH-USDT', side: 'buy', type: 'limit', tif: 'POST_ONLY', price: '2000', qty: '0.1' } });
    expect(po.json.order.status).toBe('rejected');
    expect((await balances(h.app, bob.token)).USDT.locked).toBe('0');
    // EN: Bad tick / insufficient funds / unknown market. / ES: Tick inválido / fondos insuficientes / mercado desconocido.
    expect((await call(h.app, 'POST', '/orders', { token: bob.token, body: { market: 'ETH-USDT', side: 'buy', type: 'limit', price: '1999.999', qty: '0.1' } })).status).toBe(400);
    expect((await call(h.app, 'POST', '/orders', { token: bob.token, body: { market: 'ETH-USDT', side: 'buy', type: 'limit', price: '1000', qty: '100' } })).json.error).toBe('insufficient_funds');
    expect((await call(h.app, 'POST', '/orders', { token: bob.token, body: { market: 'DOGE-USDT', side: 'buy', type: 'limit', price: '1', qty: '1' } })).status).toBe(404);
    // EN: Cancel Alice's remainder; Bob cannot cancel it. / ES: Cancelar el resto de Alice; Bob no puede.
    const open = (await call(h.app, 'GET', '/orders?open=true', { token: alice.token })).json.orders;
    expect(open).toHaveLength(1);
    // EN: Another user's order looks like 404 (no information leak).
    // ES: La orden de otro usuario aparece como 404 (sin filtrar información).
    expect((await call(h.app, 'DELETE', `/orders/${open[0].id}`, { token: bob.token })).status).toBe(404);
    const c = await call(h.app, 'DELETE', `/orders/${open[0].id}`, { token: alice.token });
    expect(c.json.order.status).toBe('canceled');
    expect((await balances(h.app, alice.token)).ETH).toEqual({ available: '1.5', locked: '0', withdrawing: '0' });
    expect((await invariantsOk()).ok).toBe(true);
  });

  it('Idempotency-Key replays and refuses reuse with another body / Idempotency-Key repite y rechaza reuso con otro cuerpo', async () => {
    const body = { market: 'ANX-USDT', side: 'buy', type: 'limit', price: '0.5', qty: '10' };
    const headers = { 'idempotency-key': 'order-key-0001' };
    const r1 = await call(h.app, 'POST', '/orders', { token: bob.token, body, headers });
    const r2 = await call(h.app, 'POST', '/orders', { token: bob.token, body, headers });
    // EN: Replay returns the stored response and does not place a second order.
    // ES: El replay devuelve la respuesta guardada y no coloca una segunda orden.
    expect(r2.headers['idempotent-replay']).toBe('true');
    expect(r2.json.order.id).toBe(r1.json.order.id);
    expect((await call(h.app, 'GET', '/orders?open=true&market=ANX-USDT', { token: bob.token })).json.orders).toHaveLength(1);
    expect((await call(h.app, 'POST', '/orders', { token: bob.token, body: { ...body, qty: '20' }, headers })).status).toBe(422);
    // EN: Keys are per user. / ES: Las claves son por usuario.
    expect((await call(h.app, 'POST', '/orders', { token: alice.token, body: { ...body, side: 'sell', price: '9' }, headers })).status).not.toBe(422);
  });

  it('market freeze blocks new orders, user freeze cancels everything / congelar mercado bloquea órdenes, congelar usuario cancela todo', async () => {
    await call(h.app, 'POST', '/admin/markets/ANX-USDT/freeze', { token: admin.token, body: { frozen: true, reason: 'incident drill' } });
    expect((await call(h.app, 'POST', '/orders', { token: bob.token, body: { market: 'ANX-USDT', side: 'buy', type: 'limit', price: '0.5', qty: '10' } })).json.error).toBe('market_frozen');
    await call(h.app, 'POST', '/admin/markets/ANX-USDT/freeze', { token: admin.token, body: { frozen: false, reason: 'drill over' } });

    const f = await call(h.app, 'POST', `/admin/users/${bob.id}/freeze`, { token: admin.token, body: { frozen: true, reason: 'suspicious activity' } });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(f.json.canceled).toBe(1);
    expect((await balances(h.app, bob.token)).USDT.locked).toBe('0');
    expect((await call(h.app, 'POST', '/orders', { token: bob.token, body: { market: 'ANX-USDT', side: 'buy', type: 'limit', price: '0.5', qty: '10' } })).json.error).toBe('account_frozen');
    await call(h.app, 'POST', `/admin/users/${bob.id}/freeze`, { token: admin.token, body: { frozen: false, reason: 'cleared' } });
    const audit = await call(h.app, 'GET', '/admin/audit?action=user.freeze', { token: admin.token });
    expect(audit.json.entries.length).toBeGreaterThanOrEqual(1);
    expect((await call(h.app, 'GET', '/admin/audit/verify', { token: admin.token })).json.ok).toBe(true);
    expect((await invariantsOk()).ok).toBe(true);
  });

  it('streams book and private events over WebSocket / transmite libro y eventos privados por WebSocket', async () => {
    const ws = await h.app.injectWS('/ws');
    const msgs: any[] = [];
    ws.on('message', (d: Buffer) => msgs.push(JSON.parse(d.toString())));
    const until = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 100 && !msgs.some(pred); i++) await new Promise((r) => setTimeout(r, 20));
      return msgs.find(pred);
    };
    ws.send(JSON.stringify({ op: 'subscribe', channel: 'user' }));
    expect((await until((m) => m.type === 'error'))?.error).toBe('unauthorized');
    ws.send(JSON.stringify({ op: 'auth', token: alice.token }));
    await until((m) => m.type === 'authed');
    ws.send(JSON.stringify({ op: 'subscribe', channel: 'user' }));
    ws.send(JSON.stringify({ op: 'subscribe', channel: 'book:ETH-USDT' }));
    ws.send(JSON.stringify({ op: 'subscribe', channel: 'admin' }));
    expect(await until((m) => m.type === 'subscribed' && m.channel === 'book:ETH-USDT')).toBeTruthy();
    expect((await until((m) => m.error === 'forbidden'))).toBeTruthy();
    await call(h.app, 'POST', '/orders', { token: alice.token, body: { market: 'ETH-USDT', side: 'sell', type: 'limit', price: '2500', qty: '0.1' } });
    expect(await until((m) => m.channel === 'user' && m.data?.type === 'orders_changed')).toBeTruthy();
    expect(await until((m) => m.channel === 'book:ETH-USDT' && m.data?.asks?.some((l: any) => l.price === '2500'))).toBeTruthy();
    ws.terminate();
  });

  it('a restarted API rebuilds identical books from the DB / una API reiniciada reconstruye libros idénticos desde la BD', async () => {
    const before = (await call(h.app, 'GET', '/markets/ETH-USDT/book')).json;
    const { buildApp } = await import('../src/index.js');
    const again = await buildApp({ config: h.config, db: h.db });
    const after = (await again.app.inject({ method: 'GET', url: '/markets/ETH-USDT/book' })).json();
    expect(after.asks).toEqual(before.asks);
    expect(after.bids).toEqual(before.bids);
    expect(await again.services.exchange.checkBooksAgainstDb()).toEqual([]);
    await again.app.close();
  });
});
