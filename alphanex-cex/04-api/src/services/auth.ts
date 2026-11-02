/**
 * EN: Email/password auth with scrypt + opaque bearer sessions (stored hashed), plus optional
 *     wallet linking via an EIP-191 signed challenge (SIWE-style, simplified).
 * ES: Auth con email/contraseña con scrypt + sesiones bearer opacas (guardadas hasheadas), más
 *     vinculación opcional de wallet con un desafío firmado EIP-191 (estilo SIWE, simplificado).
 */
import { randomUUID, scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { verifyMessage, isAddress, getAddress, type Hex } from 'viem';
import type { Db } from '@alphanex/ledger';
import { badRequest, conflict, unauthorized } from '../errors.js';
import { randomToken, sha256 } from '../util.js';
import type { AuditLog } from './audit.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
// EN: scrypt cost parameters (N=2^15 ≈ 32 MiB). / ES: Parámetros de costo de scrypt (N=2^15 ≈ 32 MiB).
// EN: scrypt cost N=2^15, r=8, p=1 (~32 MiB, OWASP-recommended range). Parameters are stored in the hash
//     so they can be raised later without breaking existing passwords.
// ES: Costo scrypt N=2^15, r=8, p=1 (~32 MiB, rango recomendado por OWASP). Los parámetros se guardan en el hash
//     para poder subirlos luego sin romper contraseñas existentes.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** EN: "scrypt$N$r$p$salt$hash". / ES: "scrypt$N$r$p$sal$hash". */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

/** EN: Constant-time verification. / ES: Verificación en tiempo constante. */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  // EN: Constant-time comparison avoids leaking how many bytes matched.
  // ES: La comparación en tiempo constante evita filtrar cuántos bytes coincidieron.
  const dk = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem } as never);
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

export interface SessionUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  frozen: boolean;
  walletAddress: string | null;
}

export class AuthService {
  constructor(private readonly db: Db, private readonly audit: AuditLog, private readonly ttlMs: number) {}

  /** EN: Creates a user. Password policy: ≥ 10 chars. / ES: Crea un usuario. Política: ≥ 10 caracteres. */
  async register(email: string, password: string, role: 'user' | 'admin' = 'user'): Promise<SessionUser> {
    const e = String(email ?? '').trim().toLowerCase();
    // EN: Light email sanity check + password length bounds (upper bound limits scrypt DoS).
    // ES: Validación liviana del email + límites de longitud de contraseña (el máximo limita DoS por scrypt).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw badRequest('invalid_email');
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw badRequest('weak_password', 'password must be 10-200 chars');
    const id = randomUUID();
    const ph = await hashPassword(password);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('INSERT INTO users(id, email, password_hash, role) VALUES ($1,$2,$3,$4)', [id, e, ph, role]);
        await this.audit.append(tx, { actor: id, action: 'user.register', target: id, details: { role } });
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('email_taken');
      throw err;
    }
    return { id, email: e, role, frozen: false, walletAddress: null };
  }

  /**
   * EN: Returns a fresh opaque token; only its sha256 is stored. Same error for unknown email and
   *     wrong password (no user enumeration).
   * ES: Devuelve un token opaco nuevo; solo se guarda su sha256. Mismo error para email desconocido
   *     y contraseña incorrecta (sin enumeración de usuarios).
   */
  async login(email: string, password: string): Promise<{ token: string; user: SessionUser; expiresAt: string }> {
    const r = await this.db.query<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = $1', [String(email ?? '').trim().toLowerCase()]);
    const row = r.rows[0];
    // EN: Verify against a dummy hash when user is missing to equalize timing. / ES: Verificar contra un hash ficticio si falta el usuario para igualar tiempos.
    // EN: Unknown email still runs scrypt against a dummy hash, so timing does not reveal which emails exist.
    // ES: Un email desconocido igual ejecuta scrypt contra un hash ficticio, así el tiempo no revela qué emails existen.
    const ok = row ? await verifyPassword(String(password ?? ''), row.password_hash) : (await verifyPassword('x', DUMMY_HASH), false);
    if (!row || !ok) throw unauthorized('invalid credentials');
    // EN: Only sha256(token) is stored: a DB leak does not leak usable session tokens.
    // ES: Solo se guarda sha256(token): una fuga de la BD no filtra tokens de sesión utilizables.
    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [sha256(token), row.id, expiresAt.toISOString()]);
      await this.audit.append(tx, { actor: row.id, action: 'user.login', target: row.id });
    });
    return { token, user: (await this.getUser(row.id))!, expiresAt: expiresAt.toISOString() };
  }

  /** EN: Resolves a bearer token. / ES: Resuelve un token bearer. */
  async authenticate(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const r = await this.db.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(token)]);
    return r.rows[0] ? this.getUser(r.rows[0].user_id) : null;
  }

  /** EN: Revokes a session. / ES: Revoca una sesión. */
  async logout(token: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  }

  /** EN: Loads a user. / ES: Carga un usuario. */
  async getUser(id: string): Promise<SessionUser | null> {
    const r = await this.db.query<{ id: string; email: string; role: 'user' | 'admin'; frozen: boolean; wallet_address: string | null }>(
      'SELECT id, email, role, frozen, wallet_address FROM users WHERE id = $1',
      [id],
    );
    const u = r.rows[0];
    return u ? { id: u.id, email: u.email, role: u.role, frozen: u.frozen, walletAddress: u.wallet_address } : null;
  }

  /** EN: Issues a wallet-link challenge message. / ES: Emite el mensaje de desafío para vincular wallet. */
  async walletChallenge(userId: string, address: string): Promise<{ message: string }> {
    if (!isAddress(address)) throw badRequest('invalid_address');
    // EN: One-time nonce (SIWE-style message) proves control of the wallet; it expires and is deleted on use.
    // ES: Nonce de un solo uso (mensaje estilo SIWE) prueba el control de la wallet; expira y se borra al usarse.
    const nonce = randomToken(16);
    await this.db.query(
      `INSERT INTO wallet_challenges(user_id, nonce, expires_at) VALUES ($1,$2, now() + interval '5 minutes')
       ON CONFLICT (user_id) DO UPDATE SET nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at`,
      [userId, nonce],
    );
    return { message: challengeMessage(getAddress(address), userId, nonce) };
  }

  /** EN: Verifies the signature and links the wallet (one-time nonce). / ES: Verifica la firma y vincula la wallet (nonce de un uso). */
  async linkWallet(userId: string, address: string, signature: string): Promise<SessionUser> {
    if (!isAddress(address)) throw badRequest('invalid_address');
    // EN: DELETE ... RETURNING consumes the challenge atomically: a signature can never be replayed.
    // ES: DELETE ... RETURNING consume el desafío de forma atómica: una firma nunca puede reutilizarse.
    const c = await this.db.query<{ nonce: string }>('DELETE FROM wallet_challenges WHERE user_id = $1 AND expires_at > now() RETURNING nonce', [userId]);
    const nonce = c.rows[0]?.nonce;
    if (!nonce) throw badRequest('no_challenge');
    const addr = getAddress(address);
    const ok = await verifyMessage({ address: addr, message: challengeMessage(addr, userId, nonce), signature: signature as Hex }).catch(() => false);
    if (!ok) throw unauthorized('bad wallet signature');
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('UPDATE users SET wallet_address = $2 WHERE id = $1', [userId, addr]);
        await this.audit.append(tx, { actor: userId, action: 'user.wallet_link', target: userId, details: { address: addr } });
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('wallet_already_linked');
      throw err;
    }
    return (await this.getUser(userId))!;
  }
}

/** EN: Human-readable challenge (shown in the wallet). / ES: Desafío legible (se muestra en la wallet). */
export function challengeMessage(address: string, userId: string, nonce: string): string {
  return `AlphaNex wants you to link ${address} to account ${userId}.\nThis does not authorize any transaction.\nNonce: ${nonce}`;
}

// EN: Precomputed dummy hash for timing equalization. / ES: Hash ficticio precalculado para igualar tiempos.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
