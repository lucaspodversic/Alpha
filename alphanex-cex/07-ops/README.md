# 07-ops — Operations / Operaciones

| Path | EN | ES |
|---|---|---|
| `docker-compose.yml` | Local/staging stack (postgres, anvil, signer, api, watcher, web). Host ports bound to 127.0.0.1; signer has no published port. | Stack local/staging. Puertos del host atados a 127.0.0.1; el firmante no publica puertos. |
| `docker/` | Hardened images (non-root, read-only FS, no capabilities). | Imágenes endurecidas (sin root, FS de solo lectura, sin capabilities). |
| `ci/ci.yml` | Copy of `/.github/workflows/ci.yml` for review. | Copia de `/.github/workflows/ci.yml` para revisión. |
| `.env.example` | Variables for compose — copy to `.env`, never commit `.env`. | Variables de compose — copiar a `.env`, nunca commitear `.env`. |
| `runbooks/` | Incident runbooks: critical reorg, reconciliation deficit (auto-halt + resume), signer compromise, stuck withdrawal, book/DB divergence, audit-chain break, freezes. | Runbooks: reorg crítico, déficit de conciliación (auto-halt + reanudar), compromiso del firmante, retiro trabado, divergencia libro/BD, ruptura de auditoría, congelamientos. |
| `staging-checklist.*.md` | Go/no-go list before staging. | Lista de go/no-go antes de staging. |
| `scripts/comment-density.mjs` | CI gate: ≥ 25% comment lines per package. | Control de CI: ≥ 25% de líneas de comentario por paquete. |

```bash
# EN: Run the stack (needs Docker). / ES: Levantar el stack (requiere Docker).
cp 07-ops/.env.example 07-ops/.env    # fill values / completar valores
docker compose -f 07-ops/docker-compose.yml --env-file 07-ops/.env up --build
node 07-ops/scripts/comment-density.mjs --min 25
```

**Admin kill switches / Interruptores de admin:** `POST /admin/markets/:id/freeze`, `POST /admin/users/:id/freeze`, `POST /admin/withdrawals/halt` (all audited / todos auditados).
