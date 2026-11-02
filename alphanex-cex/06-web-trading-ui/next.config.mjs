/**
 * EN: Next.js config. Strict security headers; the API origin is the only allowed connect target.
 * ES: Config de Next.js. Headers de seguridad estrictos; el origen de la API es el único destino de conexión permitido.
 */
const api = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:4000';
// EN: WebSocket origin derived from the API origin; both go into the CSP connect-src.
// ES: Origen WebSocket derivado del de la API; ambos van al connect-src de la CSP.
const ws = api.replace(/^http/, 'ws');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // EN: Do not advertise the framework (X-Powered-By).
  // ES: No anunciar el framework (X-Powered-By).
  poweredByHeader: false,
  // EN: Small self-contained server bundle for Docker. / ES: Bundle de servidor autocontenido para Docker.
  output: 'standalone',
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // EN: Anti-clickjacking, no MIME sniffing, no referrer leaks.
          // ES: Anti-clickjacking, sin MIME sniffing, sin filtrar referrer.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Content-Security-Policy',
            // EN: Next needs inline scripts/styles for hydration in this simple setup (no nonce plumbing).
            // ES: Next necesita scripts/estilos inline para la hidratación en esta configuración simple (sin nonces).
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${api} ${ws}; frame-ancestors 'none'`,
          },
        ],
      },
    ];
  },
};
export default nextConfig;
