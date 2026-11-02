# AlphaNex CEX — reference implementation / implementación de referencia

> **EN:** Solution to the "Blockchain / Exchange Engineer — AlphaNex CEX Platform" brief: evolve a P2P escrow MVP into a centralized exchange **without breaking accounting invariants**. Testnet / local only.
> **ES:** Solución a la búsqueda "Blockchain / Exchange Engineer — AlphaNex CEX Platform": evolucionar un MVP de escrow P2P a un exchange centralizado **sin romper invariantes contables**. Solo testnet / local.

## Folders / Carpetas (mapped to the 90-day goals / según los objetivos de 90 días)

| Folder | EN | ES |
|---|---|---|
| `01-rfc-arquitectura/` | Architecture RFC (ledger, matching, custody, migration from P2P) — EN + ES. **Goal 1** | RFC de arquitectura (ledger, matching, custodia, migración desde P2P) — EN + ES. **Objetivo 1** |
| `02-matching-engine/` | In-memory price-time engine: limit/market, GTC/IOC/POST_ONLY, self-trade prevention. **Goal 2** | Motor precio-tiempo en memoria: límite/mercado, GTC/IOC/POST_ONLY, prevención de auto-trade. **Objetivo 2** |
| `03-ledger/` | Double-entry ledger on Postgres/PGlite, non-negative CHECKs, invariants. **Goal 2** | Ledger de partida doble sobre Postgres/PGlite, CHECKs de no-negativos, invariantes. **Objetivo 2** |
| `04-api/` | Fastify REST + WebSocket: auth, ETH/USDT + ANX/USDT markets, deposits, 4-eyes withdrawals, admin, audit, idempotency. **Goals 2, 3, 5** | REST + WebSocket con Fastify: auth, mercados ETH/USDT + ANX/USDT, depósitos, retiros de 4 ojos, admin, auditoría, idempotencia. **Objetivos 2, 3, 5** |
| `05-blockchain-custody/` | EVM custody: HD deposit addresses, watcher with confirmations + reorgs, isolated signer with policy, reconciliation, Solidity (`P2PEscrow` with `retire()`, test tokens). **Goal 3** | Custodia EVM: direcciones HD, watcher con confirmaciones + reorgs, firmante aislado con política, conciliación, Solidity. **Objetivo 3** |
| `06-web-trading-ui/` | Next.js 14 trading UI wired to the real API (book, chart, orders, balances, funding, admin). **Goal 4** | UI de trading Next.js 14 conectada a la API real (libro, gráfico, órdenes, saldos, fondos, admin). **Objetivo 4** |
| `07-ops/` | Docker/compose (loopback only), CI, runbooks, staging checklist, comment-density gate. **Goal 5** | Docker/compose (solo loopback), CI, runbooks, checklist de staging, control de comentarios. **Objetivo 5** |
| `08-postulacion/` | Application note (EN/ES) + CV templates (placeholders only). | Nota de postulación (EN/ES) + plantillas de CV (solo marcadores). |

## Quick start / Inicio rápido

```bash
# EN: Node >= 20, Foundry optional (contracts + anvil test). / ES: Node >= 20, Foundry opcional.
npm install
npm run typecheck
npm test                      # EN: all workspaces, offline / ES: todos los workspaces, offline
npm run contracts:test        # forge test (05-blockchain-custody/contracts)
npm run build:web
node 07-ops/scripts/comment-density.mjs --min 25

# EN: Local dev (embedded PGlite, dev faucet, 127.0.0.1). / ES: Desarrollo local (PGlite embebido, faucet dev, 127.0.0.1).
cp 04-api/.env.example 04-api/.env              # EN: set ADMIN_* to create admins / ES: completar ADMIN_* para crear admins
cp 06-web-trading-ui/.env.example 06-web-trading-ui/.env.local
npm run dev:api     # http://127.0.0.1:4000
npm run dev:web     # http://127.0.0.1:3000
```

Full stack with anvil + signer + watcher + Postgres / Stack completo: see / ver `07-ops/README.md`.

## Security posture / Postura de seguridad
- **EN:** No secrets in the repo (only `.env.example`); keys are read from env only. Services bind to `127.0.0.1` by default; `0.0.0.0` is refused unless `ALLOW_PUBLIC_BIND=true`. `CHAIN_ID` must be 31337 (anvil) or 11155111 (Sepolia). Withdrawals need two distinct admins + a separate signer with caps; a reconciliation deficit auto-halts withdrawals; every admin action is in a hash-chained audit log.
- **ES:** Sin secretos en el repo (solo `.env.example`); las claves salen solo del entorno. Los servicios escuchan en `127.0.0.1` por defecto; `0.0.0.0` se rechaza salvo `ALLOW_PUBLIC_BIND=true`. `CHAIN_ID` debe ser 31337 (anvil) o 11155111 (Sepolia). Los retiros necesitan dos admins distintos + un firmante separado con topes; un déficit de conciliación detiene los retiros automáticamente; toda acción de admin queda en un log de auditoría encadenado por hash.

## Code comments / Comentarios del código
EN: All code is commented in English and Spanish (`// EN:` / `// ES:`), ≥ 25% comment lines per package, enforced in CI.
ES: Todo el código está comentado en inglés y español (`// EN:` / `// ES:`), ≥ 25% de líneas de comentario por paquete, verificado en CI.

## Known limitations / Limitaciones conocidas
- EN: No FOK/stop orders; no automatic hot→cold sweeps; in-process event bus (single API instance); deposit-address keys are not managed by the signer; the withdrawal kill switch is global (not per asset); fiat/KYC out of scope.
- ES: Sin órdenes FOK/stop; sin barridos automáticos hot→fría; bus de eventos en proceso (una sola instancia de API); las claves de las direcciones de depósito no las gestiona el firmante; el interruptor de retiros es global (no por activo); fiat/KYC fuera de alcance.

## License / Licencia
MIT — see / ver `LICENSE`.
