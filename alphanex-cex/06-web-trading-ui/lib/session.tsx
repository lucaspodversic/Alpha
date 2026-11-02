'use client';
/**
 * EN: Session context: current user + login/logout helpers shared by all pages.
 * ES: Contexto de sesión: usuario actual + helpers de login/logout compartidos por todas las páginas.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, type User } from './api';

interface Ctx {
  user: User | null;
  ready: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}
// EN: Default value is only used outside the provider (never in this app).
// ES: El valor por defecto solo se usa fuera del provider (nunca en esta app).
const SessionCtx = createContext<Ctx>({ user: null, ready: false, refresh: async () => {}, login: async () => {}, logout: async () => {} });

// EN: `ready` stays false until the first /auth/me check finishes (avoids flashing “log in”).
// ES: `ready` queda en false hasta terminar el primer chequeo /auth/me (evita mostrar “iniciar sesión” por un instante).
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  // EN: Resolve the current user from the stored token; an invalid token simply means logged out.
  // ES: Resolver el usuario actual desde el token guardado; un token inválido simplemente significa sin sesión.
  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setReady(true);
      return;
    }
    try {
      setUser((await api<{ user: User }>('/auth/me')).user);
    } catch {
      setUser(null);
    }
    setReady(true);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // EN: Errors (401, 429) propagate to the login form, which shows them.
  // ES: Los errores (401, 429) se propagan al formulario de login, que los muestra.
  const login = async (email: string, password: string) => {
    const r = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { email, password } });
    setToken(r.token);
    setUser(r.user);
  };
  // EN: Clear locally even if the server call fails (e.g. API down).
  // ES: Limpiar localmente aunque falle la llamada al servidor (p. ej. API caída).
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setToken(null);
    setUser(null);
  };
  return <SessionCtx.Provider value={{ user, ready, refresh, login, logout }}>{children}</SessionCtx.Provider>;
}

// EN: Hook used by every page/component to read the session.
// ES: Hook que usan todas las páginas/componentes para leer la sesión.
export const useSession = () => useContext(SessionCtx);
