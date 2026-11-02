# AlphaNex CEX — Incident runbooks (EN)

> Scope: testnet / local reference deployment. Every admin action below is audited with a mandatory reason.
> Rule zero: **freeze first, investigate second, never "fix" balances with raw SQL alone.**

All endpoints require an admin session (`Authorization: Bearer <token>`). The API binds to `127.0.0.1` by default.

---

## RB-1 · Critical reorg (a credited deposit disappeared)

**Signal:** `admin` channel alert `credited deposit <id> reorged out`; audit action `deposit.critical_reorg`; deposit status `reorged_after_credit`.

**What the system already did:** froze the user (orders canceled, trading + withdrawals blocked) and audited it. It did **not** reverse the credit (the funds may already have been traded).

**Steps**
1. Confirm on a block explorer / your own node that the tx is really gone (not just a slow re-inclusion). Wait for N more confirmations.
2. `POST /admin/reconcile` → expect a deficit for that asset (this also **auto-halts withdrawals**, see RB-2).
3. Decide with a second operator: (a) tx re-included → nothing to do; (b) tx gone → book an audited adjustment from the user's balance (if negative, it stays as a receivable on `equity`; NOT exposed by the MVP API — a reviewed script run by two engineers).
4. Unfreeze the user (`POST /admin/users/:id/freeze {"frozen": false, "reason": "..."}`) only after the decision is recorded.
5. Resume withdrawals per RB-2.

## RB-2 · Reconciliation deficit (withdrawals auto-halted)

**Signal:** `reconcile` report `ok: false` with a deficit; audit `withdrawals.halt` by actor `system`; users get `403 withdrawals_halted`.

**Steps**
1. `GET /admin/withdrawals/halt` → read the reason (lists the assets in deficit).
2. `GET /admin/invariants` → the ledger itself must still balance (sum = 0, no negatives). If not → stop and escalate (RB-5/RB-6).
3. Explain the gap: withdrawals `broadcast` but not confirmed (`POST /admin/withdrawals/confirm`), gas spent not yet booked, critical reorg (RB-1), or theft (RB-3).
4. Re-run `POST /admin/reconcile` until `ok: true` (or the residual gap is explained and booked).
5. Resume, with a second operator watching:
   `POST /admin/withdrawals/halt {"halted": false, "reason": "deficit explained: <ticket>"}` → audit `withdrawals.resume`.
6. Manual halt at any time: same endpoint with `{"halted": true, "reason": "..."}` (also available as a button in the Admin UI).

## RB-3 · Signer / hot-key compromise suspected

1. Halt withdrawals immediately (`POST /admin/withdrawals/halt {"halted": true, ...}`).
2. Stop the signer process (it is a separate process; the API cannot sign without it).
3. Rotate `SIGNER_HMAC_SECRET` (API + signer) and generate a **new** testnet hot key; move remaining funds from the old address with a supervised transfer.
4. Review signer policy logs vs. `withdrawals` table: every signed tx must match an `approved` withdrawal with 2 distinct approvers.
5. `POST /admin/reconcile`, document the loss (if any) as an audited adjustment, then resume (RB-2 step 5).

## RB-4 · Stuck or failed withdrawal

- `broadcast` for too long: `POST /admin/withdrawals/confirm` re-checks receipts. If dropped from the mempool → it becomes `failed`.
- `failed`: funds are still in `withdrawing`. Either re-`process` (same nonce rules apply) or `POST /admin/withdrawals/:id/reject {"reason": ...}` → amount + fee return to `available`.
- **Never** reject a `broadcast` withdrawal: it may still land on-chain (double payout).

## RB-5 · Order book / DB divergence

**Signal:** `GET /admin/invariants` reports book ≠ open orders or locked ≠ holds.

1. Freeze the affected market (`POST /admin/markets/:id/freeze`).
2. Restart the API: books are rebuilt **from the DB** (the DB is the source of truth; the engine is a cache).
3. Re-run invariants; unfreeze when clean. Attach the invariants output to the incident ticket.

## RB-6 · Audit-chain break

**Signal:** `GET /admin/audit/verify` returns `ok: false` with the first bad `seq`.

1. Treat as a security incident: someone bypassed the append-only trigger (DB-level access).
2. Freeze withdrawals and all markets; snapshot the DB.
3. Compare against backups / WAL to find the tampered rows; rotate DB credentials.
4. Do not "repair" the chain: start a new segment only after the incident is closed and documented.

## RB-7 · Market or user freeze (routine)

- Market: `POST /admin/markets/:id/freeze {"frozen": true, "reason": "..."}` — rejects new orders; cancels stay allowed.
- User: `POST /admin/users/:id/freeze {"frozen": true, "reason": "..."}` — cancels open orders, blocks trading and withdrawals.
- Unfreeze with `frozen: false`. Every change is visible in the Admin UI audit panel.
