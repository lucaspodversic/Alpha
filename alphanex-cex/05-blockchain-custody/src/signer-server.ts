/**
 * EN: Minimal HTTP wrapper around WithdrawalSigner. Binds to 127.0.0.1 by default and exposes only:
 *       GET  /health
 *       POST /sign   (header `x-signature`: HMAC of the JSON body)
 *     Run: HOT_WALLET_PRIVATE_KEY=... SIGNER_HMAC_SECRET=... SIGNER_ASSETS=... npm run signer
 * ES: Envoltorio HTTP mínimo de WithdrawalSigner. Escucha en 127.0.0.1 por defecto y expone solo:
 *       GET  /health
 *       POST /sign   (header `x-signature`: HMAC del cuerpo JSON)
 *     Ejecutar: HOT_WALLET_PRIVATE_KEY=... SIGNER_HMAC_SECRET=... SIGNER_ASSETS=... npm run signer
 */
import { createServer, type Server } from 'node:http';
import { EnvKeyProvider, PolicyError, WithdrawalSigner, policyFromEnv, type SignRequest } from './signer.js';

// EN: Max body size to avoid memory abuse. / ES: Tamaño máximo del cuerpo para evitar abuso de memoria.
const MAX_BODY = 16 * 1024;

/** EN: Creates (but does not start) the server. / ES: Crea (sin iniciar) el servidor. */
export function createSignerServer(signer: WithdrawalSigner): Server {
  return createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/sign') return send(404, { error: 'not_found' });
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(413, { error: 'too_large' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SignRequest;
        const sig = String(req.headers['x-signature'] ?? '');
        const out = await signer.sign(body, sig);
        send(200, out);
      } catch (e) {
        // EN: Never echo internals; policy errors carry a safe code. / ES: Nunca devolver internos; los errores de política llevan un código seguro.
        if (e instanceof PolicyError) send(403, { error: e.code, message: e.message });
        else send(400, { error: 'bad_request' });
      }
    });
  });
}

// EN: Entrypoint when run directly. / ES: Punto de entrada al ejecutarse directamente.
if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.SIGNER_HOST ?? '127.0.0.1';
  const port = Number(process.env.SIGNER_PORT ?? 4100);
  const signer = new WithdrawalSigner(new EnvKeyProvider(), policyFromEnv());
  createSignerServer(signer).listen(port, host, () => {
    // EN: Log address only — never the key. / ES: Loguear solo la dirección — nunca la clave.
    new EnvKeyProvider().getAccount().then((a) => console.log(`[signer] listening on http://${host}:${port} hot=${a.address}`));
  });
}
