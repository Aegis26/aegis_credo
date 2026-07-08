---
name: Ledger money-path invariants
description: Non-obvious rules for the double-entry ledger engine's automated money paths (import, AP, AR, payroll) and RBAC.
---

# Ledger money-path invariants

All money movement in this engine funnels through `postJournalEntry`. When adding
a new automated money path, honor these rules — they are enforced by convention,
not by the type system, so it is easy to violate them silently.

## Idempotency is mandatory and race-safe
Every automated money path (import, bill/invoice create + pay, payroll) MUST pass
`options.idempotencyKey` to `postJournalEntry`. The insert is race-safe:
`onConflictDoNothing` on the `(orgId, idempotencyKey)` unique index, then reload
the winning row on conflict. A plain read-then-insert is NOT enough — two
concurrent re-runs of the same event would both pass the read and double-post.

**Why:** re-imports, retries, and provider webhook replays are expected; a
double-post silently corrupts the ledger with no error.

## Document flows must be atomic with their ledger post
`createBill`/`payBill`/`createInvoice`/`payInvoice`/`postPayrollRun` each open one
`db.transaction` and thread its `tx` into `postJournalEntry` via `PostOptions.tx`
(when `tx` is supplied, `postJournalEntry` runs inside it instead of opening its
own). The document-row insert, the ledger post, and the row's `postedEntryId`
update all commit together.

**Why:** posting the ledger entry in a separate transaction from the document row
can crash between them and strand a bill/invoice/payroll row with a null
`postedEntryId` — an un-postable, un-idempotent orphan.

**How to apply:** any helper that reads/writes inside these flows (e.g. the
payment-sum helpers, `loadPostedEntry`) must accept and use the passed `tx`, not
the module-level `db`.

## RBAC is a caller-side gate
`requirePermission`/`can` in `access.ts` are NOT called inside the money-op service
functions. This is a library with no HTTP layer; whatever eventually exposes these
functions is responsible for the permission check. Do not assume the service
functions self-guard.

## Reconciliation semantics
`ReconciliationReport` compares the imported file's own trial balance against the
ledger entries produced from that file — not the org's full standing trial balance.
Prior activity in the same accounts makes the check stricter (the ledger must still
reproduce the imported file exactly), never falser.

## Money shape
Money is integer minor units as native `BigInt` end to end; JS `number` inputs are
rejected at runtime. `payroll_runs` stores gross/taxes/net amounts, not account ids.
