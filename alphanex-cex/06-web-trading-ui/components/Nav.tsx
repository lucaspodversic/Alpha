'use client';
/**
 * EN: Top bar with links, testnet banner and session controls.
 * ES: Barra superior con enlaces, aviso de testnet y controles de sesión.
 */
import Link from 'next/link';
import { useSession } from '@/lib/session';

export function Nav() {
  // EN: Links depend on the session; hiding a link is UX, the API still enforces roles.
  // ES: Los enlaces dependen de la sesión; ocultarlos es UX, la API igual aplica los roles.
  const { user, logout } = useSession();
  return (
    <header className="flex items-center gap-4 px-4 py-2 border-b border-edge bg-panel">
      <Link href="/trade/ETH-USDT" className="font-bold text-white">
        AlphaNex
      </Link>
      {/* EN: Permanent banner: this build is for testnet/local only. */}
      {/* ES: Aviso permanente: este build es solo para testnet/local. */}
      <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">TESTNET · no real funds / sin fondos reales</span>
      <nav className="flex gap-3 text-slate-300">
        <Link href="/trade/ETH-USDT">ETH/USDT</Link>
        <Link href="/trade/ANX-USDT">ANX/USDT</Link>
        {/* EN: Funding needs a session; Admin only for admins. */}
        {/* ES: Fondos requiere sesión; Admin solo para administradores. */}
        {user && <Link href="/funding">Funding / Fondos</Link>}
        {user?.role === 'admin' && <Link href="/admin">Admin</Link>}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {user ? (
          <>
            {/* EN: Show who is logged in and whether the account is frozen. */}
            {/* ES: Mostrar quién inició sesión y si la cuenta está congelada. */}
            <span className="text-slate-400">{user.email}</span>
            {user.frozen && <span className="text-ask text-xs">FROZEN / CONGELADA</span>}
            <button className="btn bg-edge" onClick={() => void logout()}>
              Logout
            </button>
          </>
        ) : (
          <Link className="btn bg-edge" href="/login">
            Login
          </Link>
        )}
      </div>
    </header>
  );
}
