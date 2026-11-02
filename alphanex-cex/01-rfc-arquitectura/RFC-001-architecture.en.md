# RFC-001 — AlphaNex: from P2P escrow to a custodial spot exchange (CEX)

| Field | Value |
|---|---|
| Status | Draft for review |
| Scope | Ledger, matching, custody, ops controls for the 90-day MVP |
| Markets | ANX/USDT, ETH/USDT (spot) |
| Chains | EVM. Local Anvil (31337) and Sepolia (11155111) only in this repo |
| Reference code | `02-matching-engine`, `03-ledger`, `04-api`, `05-blockchain-custody`, `06-web-trading-ui`, `07-ops` |

> Spanish version: [`RFC-001-arquitectura.es.md`](./RFC-001-arquitectura.es.md)

## 1. Context

Today AlphaNex runs a **P2P escrow**. Each trade locks ETH in a contract (`P2PEscrow.sol`) until a verifier confirms the fiat payment. In that model, custody *is* the contract: on-chain state is the only book, and every trade is a separate settlement.

A CEX inverts that model:

- Users **deposit** into exchange-controlled wallets.
- Trading happens **off-chain** against an internal ledger.
- Only **deposits and withdrawals** touch the chain.

That gives speed and price discovery. The cost is that the exchange now holds a **liability to every user**, and it must prove at all times that those liabilities are matched by assets.

This RFC fixes the architecture so that this proof is structural rather than aspirational.

## 2. Goals / non-goals

**Goals (90 days)**
1. A double-entry ledger that is the single source of truth for balances.
2. A deterministic price-time matching engine for two spot markets.
3. Deposit and withdrawal for one EVM asset family (ETH plus ERC-20 USDT/ANX on the same chain), with confirmations, reorg handling and reconciliation.
4. A trading UI wired to the real API and WebSocket.
5. Ops controls: user/market freeze, four-eyes withdrawals, a tamper-evident audit log and a staging checklist.

**Non-goals (explicitly deferred)**
- Mainnet.
- Fiat rails.
- Margin, derivatives.
- Multi-chain.
- MPC/HSM custody (an interface is provided; see §6.4).
- KYC provider integration.
- Horizontal scaling of matching (see §8).

## 3. High-level architecture

```
            ┌──────────── Web UI (Next.js) ───────────┐
            │  REST (Bearer session)   WS /ws          │
            └──────────────┬───────────────────────────┘
                           ▼
┌──────────────────────── API (Fastify) ─────────────────────────┐
│ auth · rate limit · idempotency · admin/ops · audit log        │
│                                                                │
│  ExchangeService ── per-market mutex ──► MatchingEngine (RAM)  │
│        │ single DB tx per command                              │
│        ▼                                                       │
│  Ledger (Postgres, double-entry, append-only postings)         │
│        ▲                       ▲                               │
│  DepositService           WithdrawalService ──HMAC──► Signer   │
└────────┼───────────────────────┼───────────────────────────────┘
         │                       │ raw signed tx        (separate process,
   Watcher process          Broadcaster                 only holder of the key)
   (confirmations, reorgs)       │
         └──────── EVM RPC (Anvil / Sepolia) ◄───────┘
```

**Trust boundaries**
- The **API never holds a private key**. It holds only an **xpub** (deposit addresses) and an HMAC secret for the signer.
- The **signer** enforces its own policy independently of the API (§6.3).

## 4. Ledger

### 4.1 Model
- **Accounts** are structured codes, so every balance is self-describing:

  | Account | Kind | Normal side |
  |---|---|---|
  | `user:<id>:<ASSET>:available` | liability | credit |
  | `user:<id>:<ASSET>:locked` | liability | credit |
  | `user:<id>:<ASSET>:withdrawing` | liability | credit |
  | `fees:<ASSET>` | revenue | credit |
  | `custody:<wallet>:<ASSET>` | asset | debit |
  | `expense:gas:<ASSET>` | expense | debit |
  | `equity:<name>:<ASSET>` | equity | credit |

- **Journal entries** contain ≥2 **postings**, all as `NUMERIC(78,0)` integers in the asset's smallest unit (wei, 1e-6 USDT). There is no floating point anywhere: the engine and the API use `bigint`, and the UI uses string decimals.
- Every entry has an **idempotency key** (`deposit:<txHash>:<logIndex>`, `trade:<market>:<seq>`, `withdrawal:<id>:reserve`, …). Re-posting the same key is a no-op that returns the original entry. This is what makes crash-retry safe.
- Account balances are **materialised** and updated in the same transaction as the postings. Rows are locked in a deterministic order (sorted account ids) to avoid deadlocks.

### 4.2 Invariants (checked by `checkInvariants()`, exposed at `/admin/invariants`, run in CI)
1. Every entry balances per asset: Σdebits = Σcredits.
2. The materialised balance equals the sum of postings, for every account.
3. Per asset, the debit-normal balances equal the credit-normal balances (the books close). Concretely: **custody + expenses = user liabilities + fees + equity**.
4. No account that forbids negatives is negative. A DB `CHECK` enforces this at write time, too.
5. (On-chain, §6.5) The on-chain balance of controlled wallets equals the ledger custody, adjusted for in-flight withdrawals.

### 4.3 Canonical flows
| Event | Postings |
|---|---|
| Deposit confirmed | Dr `custody:hot` / Cr `user:available` |
| Place order | Dr `user:available` / Cr `user:locked` (hold) |
| Trade (buy side) | Dr buyer `locked` quote / Cr seller `available` quote − seller fee; Dr seller `locked` base / Cr buyer `available` base − buyer fee; fees → `fees:*` |
| Cancel / leftover | Dr `user:locked` / Cr `user:available` |
| Withdrawal request | Dr `available` (amount+fee) / Cr `withdrawing` |
| Withdrawal mined | Dr `withdrawing` / Cr `custody:hot` (amount), Cr `fees` (fee); gas: Dr `expense:gas` / Cr `custody:hot` |
| Withdrawal rejected / reverted | Dr `withdrawing` / Cr `available` |

**Fee convention.** The buyer pays the fee in the asset received (base) and the seller pays it in quote. Consequently, a hold never needs an extra fee buffer, and the hold for a buy limit is exactly `price × qty`.

## 5. Matching

- **Ownership.** One in-memory order book per market, with a **single writer** per market (promise mutex in the API).
- **Priority.** Price-time priority. The execution price is always the maker's price.
- **Order types.** LIMIT (GTC, IOC, POST_ONLY) and MARKET.
  - MARKET buys are bounded by `maxQuote`, i.e. the funds actually held.
- **Self-trade prevention.** Mode is "expire taker".
- **Integer arithmetic.** `tick`, `lot` and decimals are validated so that `price × qty` is always an exact integer in quote units. This removes rounding from settlement.
  - ETH-USDT: tick 0.01, lot 0.0001.
  - ANX-USDT: tick 0.0001, lot 0.01, minQty 1.
- **Atomicity.** Each command runs as **one DB transaction**: hold → `engine.submit` → settle each trade in the ledger → persist orders and trades → release leftovers.
  - If anything throws, the DB rolls back and the book is **rebuilt from the DB**.
  - The **DB is the source of truth; the book is a cache.** On restart, books are rebuilt from open orders ordered by `seq`. The test `restart rebuild` covers this.
- **Fees.** Maker 10 bps and taker 20 bps (configurable per market).
- **Kill switches.**
  - Market freeze: rejects new orders but still allows cancels.
  - User freeze: cancels all open orders and blocks trading and withdrawals.

## 6. Custody

### 6.1 Deposits
- **Addresses.** Each user gets one address derived from an **xpub** (BIP-44 `m/44'/60'/0'/0/i`). The API refuses `xprv`/`tprv` input.
- **Watcher process.** The watcher scans blocks, checks `parentHash` continuity, records native transfers and ERC-20 `Transfer` logs to known addresses as **pending**, and credits them once `confirmations ≥ threshold` (default 12; configurable per asset). Before crediting it re-checks that the block hash is still canonical.
- **Exactly-once.** The id `txHash:logIndex` is the ledger idempotency key, so a crash between "credit" and "save cursor" cannot double-credit.

### 6.2 Reorgs
- **Pending deposit in a reorged block.** The deposit is orphaned and nothing is posted.
- **Credited deposit disappears (critical).** This means the confirmation depth was too shallow. There is **no automatic reversal**, because the user may already have traded or withdrawn. Instead:
  1. The user is frozen.
  2. Their open orders are cancelled.
  3. The deposit is flagged.
  4. An admin alert is emitted.

  Reconciliation will show the resulting deficit. A human decides the reversal through an audited adjustment.

### 6.3 Withdrawals (four-eyes plus an independent signer)
State machine: `pending_approval → approved → broadcast → completed | failed`, plus `rejected` (refund).

- **Request.** The user request is idempotent (`Idempotency-Key`) and limited per tx and per rolling 24 h per asset. Funds plus fee move to `withdrawing`.
- **Approval.** **Two distinct admins** must approve, and neither may be the requester.
- **Signing.** The **signer** (separate process, 127.0.0.1, HMAC-authenticated, with a freshness window and replay protection by withdrawal id) re-checks the approvals, the asset allowlist, the caps and the **chainId allowlist** (31337/11155111 by default). It returns a signed raw tx; the API persists the hash *before* broadcasting.
- **Confirmation.** On receipt OK, the withdrawal completes and gas is booked to `expense:gas`. On revert it becomes `failed`, and funds stay reserved until an admin refunds them.

### 6.4 Keys
- **MVP setup.** A testnet hot key lives only in the signer's environment, and a cold wallet is held offline (manual).
- **Production path.** Replace the signer's key backend with an HSM/MPC provider behind the same `/sign` contract. Add per-asset hot-wallet ceilings with automatic hot→cold sweeps (`moveCustody`, which is ledger-neutral).

### 6.5 Reconciliation
`reconcile()` compares the on-chain balances of the controlled addresses (hot plus deposit addresses) with `custody:*` in the ledger, adjusted for in-flight withdrawals.

- **Deficit.** This is CRITICAL: the global withdrawal kill switch (`kv.withdrawals_halted`) is set automatically (actor `system`, audited as `withdrawals.halt`) and an alert is raised on the `admin` channel. While halted, new withdrawal requests and signing return `403 withdrawals_halted`; approvals and rejections still work. An admin resumes with `POST /admin/withdrawals/halt {"halted": false, "reason": "..."}` (audited as `withdrawals.resume`) after the runbook in `07-ops/runbooks/`.
- **Surplus.** This is a WARN, e.g. unattributed transfers or gas top-ups.

The watcher runs it every 5 min, and admins can run it on demand.

## 7. Ops & security controls
- **Audit log.** Append-only and **hash-chained**: `hash = sha256(prev_hash | seq | at | actor | action | target | details)`. Tampering is detectable through `/admin/audit/verify`, which the tests cover. Every admin action and every freeze is audited, with a mandatory reason.
- **Sessions.** Opaque random tokens; only their SHA-256 is stored. Passwords use scrypt.
- **Wallet linking.** Done through a one-time signed challenge (EIP-191).
- **Request handling.**
  - Strict JSON schemas and body limits.
  - Global rate limit plus a stricter per-IP auth limit.
  - Security headers and a CSP in the UI.
- **Network.** Services bind to `127.0.0.1` unless `ALLOW_PUBLIC_BIND=true`.
- **Startup guards.** The process refuses to start with a non-testnet `CHAIN_ID`, and the dev faucet is forced off when `NODE_ENV=production`.
- **Staging gate.** See `07-ops/staging-checklist.*.md`.

## 8. Scaling path (after the MVP)
1. **Event bus.** Swap the in-process `EventBus` for Redis/NATS. The WS fan-out then scales horizontally, while the matching writer stays a singleton per market behind a leader lease.
2. **Ordered command log.** Move from "one DB tx per command" to a sequenced command journal (Kafka or Postgres `seq`) with asynchronous ledger projection. Keep the idempotency keys, so the invariants hold unchanged.
3. **Sharding.** Shard markets across matching nodes. The ledger stays a single logical DB, partitioned by asset if needed.

## 9. Migrating from P2P escrow without breaking accounting
1. **Freeze the old path, but not the funds.** `P2PEscrow.retire()` is one-way: it blocks *new* escrows, while `release`/`refund` keep working, so no user is ever stuck.
2. **Opening balances.** Users who opt in deposit into their CEX address the normal way. There is no "migration credit" and **no balance created without a matching custody debit**.
3. **Dual-run.** Run P2P and CEX side by side behind feature flags. Track escrow TVL on-chain and expect it to decrease monotonically.
4. **Gate the cut-over.** The cut-over requires a green invariant check, a clean reconciliation and a verified audit chain on staging (checklist).

## 10. Risks & open questions
| Risk | Mitigation |
|---|---|
| Shallow confirmations on L2/testnet | Per-asset thresholds, critical-reorg freeze, reconciliation |
| API compromise | No keys in the API; signer re-validates; two approvers; caps |
| Insider withdrawal | Four-eyes rule, requester ≠ approver, audit hash chain, per-asset daily caps |
| Book/DB divergence | DB is the source of truth; rollback triggers a rebuild; restart rebuild |
| Hot wallet exhaustion | Treasury funding is booked as equity; reconciliation alerts; hot→cold policy |

Open questions:
- Choice of KYC provider.
- Fee tiers.
- Chain for ANX (same chain as USDT?).
- MPC vendor.
