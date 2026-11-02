# Checklist de staging (ES)

Marcar cada ítem antes de promover un build a staging. Staging = **solo testnet** (anvil 31337 o Sepolia 11155111).

## Build y CI
- [ ] CI en verde: typecheck, tests unitarios de cada workspace, `forge test`, `forge fmt --check`, build web, densidad de comentarios ≥ 25%, lint de compose.
- [ ] `npm ci` desde un checkout limpio; lockfile sin cambios.
- [ ] Tags de imagen fijados al SHA del commit.

## Configuración y secretos
- [ ] `.env` creado desde `.env.example`; **ningún secreto en git** (`git grep -i private_key` solo devuelve ejemplos vacíos).
- [ ] `CHAIN_ID` es 31337 o 11155111 (la API rechaza cualquier otro).
- [ ] `NODE_ENV=production` → faucet de desarrollo apagado; verificar que `POST /dev/faucet` devuelve 404.
- [ ] `HOST=127.0.0.1` (o detrás de un reverse proxy); `ALLOW_PUBLIC_BIND` solo dentro de la red de compose.
- [ ] `SIGNER_HMAC_SECRET` ≥ 32 bytes aleatorios, distinto de cualquier otra variable; el firmante **no publica puertos**.
- [ ] La hot wallet es una clave de testnet nueva con saldo chico; topes por activo en `SIGNER_ASSETS` y `/admin/limits`.
- [ ] Existen dos cuentas de admin distintas (las aprobaciones de cuatro ojos necesitan dos personas).

## Datos e invariantes
- [ ] Migraciones aplicadas sobre un Postgres vacío; una segunda corrida no hace nada.
- [ ] `GET /admin/invariants` → `ok: true`.
- [ ] `GET /admin/audit/verify` → `ok: true`.
- [ ] `POST /admin/reconcile` → `ok: true`; `GET /admin/withdrawals/halt` → `halted: false`.

## Prueba funcional (smoke test)
- [ ] Registrar dos usuarios; depositar ETH de testnet en la dirección del usuario A; se acredita tras N confirmaciones.
- [ ] Colocar órdenes que crucen en ETH/USDT y ANX/USDT; trades, fees y saldos coinciden con lo esperado.
- [ ] POST_ONLY que cruzaría se rechaza; el remanente IOC expira; se evita el auto-trade.
- [ ] Retiro: pedido → aprobar (admin 1) → aprobar (admin 2) → firmar+enviar → completed; quien pide no puede aprobar.
- [ ] Interruptores: congelar mercado, congelar usuario, detener/reanudar retiros — cada uno aparece en la auditoría.
- [ ] Repetir un POST de orden con la misma Idempotency-Key → misma respuesta, sin segunda orden.

## Observabilidad y ops
- [ ] La UI de Admin recibe alertas `admin` en vivo (probar con una detención manual).
- [ ] Runbooks (`07-ops/runbooks/`) revisados por la persona de guardia.
- [ ] Backup + restore de Postgres probado una vez; los libros se reconstruyen bien tras reiniciar la API.

## Aprobación
- [ ] Ingeniero/a: ______  - [ ] Segundo revisor/a: ______  - [ ] Fecha: ______
