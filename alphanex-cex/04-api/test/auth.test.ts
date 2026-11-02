// EN: Auth, sessions, wallet linking and auth rate limiting. / ES: Auth, sesiones, vinculación de wallet y rate limit de auth.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makeApp, call, PW } from './helpers.js';

let h: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  h = await makeApp();
});
afterAll(async () => {
  await h.app.close();
  await h.db.close();
});

describe('auth', () => {
  it('register → login → me → logout / registro → login → me → logout', async () => {
    const r = await call(h.app, 'POST', '/auth/register', { body: { email: 'Ana@Example.com', password: PW } });
    expect(r.status).toBe(201);
    // EN: Emails are normalized to lowercase.
    // ES: Los emails se normalizan a minúsculas.
    expect(r.json.user.email).toBe('ana@example.com');
    const l = await call(h.app, 'POST', '/auth/login', { body: { email: 'ana@example.com', password: PW } });
    expect(l.status).toBe(200);
    const me = await call(h.app, 'GET', '/auth/me', { token: l.json.token });
    expect(me.json.user.role).toBe('user');
    // EN: Only the hash is stored. / ES: Solo se guarda el hash.
    // EN: The raw token is never stored, only its hash.
    // ES: El token crudo nunca se guarda, solo su hash.
    const stored = await h.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(stored.rows.some((x) => x.token_hash === l.json.token)).toBe(false);
    expect((await call(h.app, 'POST', '/auth/logout', { token: l.json.token })).status).toBe(204);
    expect((await call(h.app, 'GET', '/auth/me', { token: l.json.token })).status).toBe(401);
  });

  it('rejects duplicates, weak passwords and bad credentials / rechaza duplicados, contraseñas débiles y credenciales malas', async () => {
    await call(h.app, 'POST', '/auth/register', { body: { email: 'bob@example.com', password: PW } });
    expect((await call(h.app, 'POST', '/auth/register', { body: { email: 'bob@example.com', password: PW } })).status).toBe(409);
    expect((await call(h.app, 'POST', '/auth/register', { body: { email: 'c@example.com', password: 'short' } })).json.error).toBe('weak_password');
    // EN: Mass assignment: an extra "role" field is stripped by the schema. / ES: Asignación masiva: el campo extra "role" lo quita el schema.
    // EN: Mass-assignment attempt: the `role` field is stripped by the schema.
    // ES: Intento de asignación masiva: el esquema elimina el campo `role`.
    const mass = await call(h.app, 'POST', '/auth/register', { body: { email: 'c@example.com', password: PW, role: 'admin' } });
    expect(mass.json.user.role).toBe('user');
    const a = await call(h.app, 'POST', '/auth/login', { body: { email: 'bob@example.com', password: PW + 'x' } });
    const b = await call(h.app, 'POST', '/auth/login', { body: { email: 'nobody@example.com', password: PW } });
    // EN: Same answer for both (no user enumeration). / ES: Misma respuesta para ambos (sin enumeración).
    expect([a.status, b.status]).toEqual([401, 401]);
    // EN: Wrong password and unknown user give the same answer (no user enumeration).
    // ES: Contraseña incorrecta y usuario inexistente dan la misma respuesta (sin enumeración de usuarios).
    expect(a.json.message).toBe(b.json.message);
  });

  it('links a wallet with a signed challenge (one-time) / vincula una wallet con un desafío firmado (un uso)', async () => {
    await call(h.app, 'POST', '/auth/register', { body: { email: 'w@example.com', password: PW } });
    const { json } = await call(h.app, 'POST', '/auth/login', { body: { email: 'w@example.com', password: PW } });
    const acct = privateKeyToAccount(generatePrivateKey());
    const ch = await call(h.app, 'POST', '/auth/wallet/challenge', { token: json.token, body: { address: acct.address } });
    expect(ch.json.message).toContain(acct.address);
    // EN: A throwaway local key signs the challenge (no real wallet involved).
    // ES: Una clave local descartable firma el desafío (sin wallet real).
    const signature = await acct.signMessage({ message: ch.json.message });
    const ok = await call(h.app, 'POST', '/auth/wallet/link', { token: json.token, body: { address: acct.address, signature } });
    expect(ok.json.user.walletAddress).toBe(acct.address);
    // EN: Replaying the same signature fails (nonce consumed). / ES: Repetir la misma firma falla (nonce consumido).
    expect((await call(h.app, 'POST', '/auth/wallet/link', { token: json.token, body: { address: acct.address, signature } })).json.error).toBe('no_challenge');
    // EN: Signature from another key is refused. / ES: Firma de otra clave se rechaza.
    const ch2 = await call(h.app, 'POST', '/auth/wallet/challenge', { token: json.token, body: { address: acct.address } });
    // EN: A signature from a different key must not link the address.
    // ES: Una firma de otra clave no debe vincular la dirección.
    const evil = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: ch2.json.message });
    expect((await call(h.app, 'POST', '/auth/wallet/link', { token: json.token, body: { address: acct.address, signature: evil } })).status).toBe(401);
  });

  it('non-admins cannot reach admin routes / no-admins no acceden a rutas admin', async () => {
    const { json } = await call(h.app, 'POST', '/auth/login', { body: { email: 'bob@example.com', password: PW } });
    expect((await call(h.app, 'GET', '/admin/audit', { token: json.token })).status).toBe(403);
    expect((await call(h.app, 'GET', '/admin/audit')).status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('auth endpoints have a stricter limit / los endpoints de auth tienen un límite más estricto', async () => {
    const x = await makeApp({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call(x.app, 'POST', '/auth/login', { body: { email: 'z@example.com', password: PW } })).status);
    // EN: After 3 attempts per minute the auth routes answer 429.
    // ES: Tras 3 intentos por minuto las rutas de auth responden 429.
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    // EN: Public market data is unaffected. / ES: Los datos públicos no se ven afectados.
    // EN: Public market data is not affected by the auth limiter.
    // ES: Los datos públicos de mercado no se ven afectados por el limitador de auth.
    expect((await call(x.app, 'GET', '/markets')).status).toBe(200);
    await x.app.close();
    await x.db.close();
  });
});
