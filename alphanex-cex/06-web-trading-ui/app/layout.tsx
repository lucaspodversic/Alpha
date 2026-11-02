/**
 * EN: Root layout: session provider + top navigation.
 * ES: Layout raíz: proveedor de sesión + navegación superior.
 */
import './globals.css';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import { Nav } from '@/components/Nav';

// EN: Title states testnet so screenshots are never mistaken for production.
// ES: El título indica testnet para que las capturas nunca se confundan con producción.
export const metadata = { title: 'AlphaNex Exchange (testnet)', description: 'AlphaNex CEX reference UI' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* EN: Session context wraps every page so all of them share the same user state. */}
        {/* ES: El contexto de sesión envuelve todas las páginas para compartir el mismo estado de usuario. */}
        <SessionProvider>
          <Nav />
          <main className="p-3">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
