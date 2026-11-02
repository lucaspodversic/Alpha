'use client';
/**
 * EN: Login / register form. Passwords go only to the API over the configured URL; nothing is stored
 *     except the session token (sessionStorage).
 * ES: Formulario de login / registro. Las contraseñas van solo a la API; no se guarda nada salvo el
 *     token de sesión (sessionStorage).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const { login } = useSession();
  const router = useRouter();
  // EN: One form, two modes: log in or create an account.
  // ES: Un formulario, dos modos: iniciar sesión o crear cuenta.
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // EN: Prevents double submits while the request is pending.
  // ES: Evita envíos dobles mientras el pedido está pendiente.
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // EN: Register then log in immediately; the password policy (min 10) is enforced by the server.
      // ES: Registrar y luego iniciar sesión enseguida; la política de contraseña (mín. 10) la aplica el servidor.
      if (mode === 'register') await api('/auth/register', { method: 'POST', body: { email, password } });
      await login(email, password);
      // EN: After login, go to the default market.
      // ES: Tras el login, ir al mercado por defecto.
      router.push('/trade/ETH-USDT');
    } catch (x) {
      // EN: Shows codes like invalid_credentials or rate_limited (the API throttles login attempts).
      // ES: Muestra códigos como invalid_credentials o rate_limited (la API limita intentos de login).
      setErr(x instanceof ApiError ? `${x.code}: ${x.message}` : String(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="panel max-w-sm mx-auto mt-10 space-y-3">
      <h1 className="text-lg font-semibold">{mode === 'login' ? 'Log in / Iniciar sesión' : 'Register / Registrarse'}</h1>
      {/* EN: Browser autocomplete hints help password managers; nothing is stored by the app. */}
      {/* ES: Las pistas de autocompletado ayudan a los gestores de contraseñas; la app no guarda nada. */}
      <input className="input" type="email" autoComplete="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input
        className="input"
        type="password"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        placeholder="password (min 10)"
        minLength={mode === 'register' ? 10 : undefined}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {/* EN: Error message from the API, if any. */}
      {/* ES: Mensaje de error de la API, si lo hay. */}
      {err && <p className="text-ask text-xs">{err}</p>}
      <button disabled={busy} className="btn bg-bid text-black w-full">
        {mode === 'login' ? 'Log in' : 'Create account / Crear cuenta'}
      </button>
      {/* EN: type=button so toggling the mode does not submit the form. */}
      {/* ES: type=button para que cambiar de modo no envíe el formulario. */}
      <button type="button" className="text-xs text-slate-400 underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'No account? Register / ¿Sin cuenta? Registrate' : 'Have an account? Log in / ¿Ya tenés cuenta? Entrá'}
      </button>
    </form>
  );
}
