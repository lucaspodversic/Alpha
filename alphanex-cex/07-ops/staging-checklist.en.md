# Staging checklist (EN)

Tick every item before promoting a build to staging. Staging = **testnet only** (anvil 31337 or Sepolia 11155111).

## Build & CI
- [ ] CI green: typecheck, unit tests in every workspace, `forge test`, `forge fmt --check`, web build, comment-density ≥ 25%, compose lint.
- [ ] `npm ci` from a clean checkout; lockfile unchanged.
- [ ] Image tags pinned to the commit SHA.

## Configuration & secrets
- [ ] `.env` created from `.env.example`; **no secret in git** (`git grep -i private_key` returns only empty examples).
- [ ] `CHAIN_ID` is 31337 or 11155111 (the API refuses anything else).
- [ ] `NODE_ENV=production` → dev faucet forced off; verify `POST /dev/faucet` returns 404.
- [ ] `HOST=127.0.0.1` (or behind a reverse proxy); `ALLOW_PUBLIC_BIND` only inside the compose network.
- [ ] `SIGNER_HMAC_SECRET` ≥ 32 random bytes, different from any other env; signer has **no published port**.
- [ ] Hot wallet is a fresh testnet key with a small balance; per-asset caps set in `SIGNER_ASSETS` and `/admin/limits`.
- [ ] Two distinct admin accounts exist (four-eyes approvals need two people).

## Data & invariants
- [ ] Migrations applied on an empty Postgres; second run is a no-op.
- [ ] `GET /admin/invariants` → `ok: true`.
- [ ] `GET /admin/audit/verify` → `ok: true`.
- [ ] `POST /admin/reconcile` → `ok: true`; `GET /admin/withdrawals/halt` → `halted: false`.

## Functional smoke test
- [ ] Register two users; deposit testnet ETH to user A's address; credited after N confirmations.
- [ ] Place crossing orders on ETH/USDT and ANX/USDT; trades, fees and balances match the expected numbers.
- [ ] POST_ONLY that would cross is rejected; IOC remainder expires; self-trade is prevented.
- [ ] Withdrawal: request → approve (admin 1) → approve (admin 2) → sign+send → completed; requester cannot approve.
- [ ] Kill switches: freeze market, freeze user, halt/resume withdrawals — each shows in the audit log.
- [ ] Replay an order POST with the same Idempotency-Key → same response, no second order.

## Observability & ops
- [ ] Admin UI receives live `admin` alerts (trigger a manual halt to test).
- [ ] Runbooks (`07-ops/runbooks/`) reviewed by the on-call person.
- [ ] Backup + restore of Postgres tested once; books rebuild correctly after an API restart.

## Sign-off
- [ ] Engineer: ______  - [ ] Second reviewer: ______  - [ ] Date: ______
