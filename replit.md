# Accounting Core (Ledger Engine)

A multi-tenant, double-entry ledger engine: schema, a balancing posting service, immutable reversing corrections, ledger-derived reports, and an automated test suite. No UI in this task.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- DB schema (source of truth): `lib/db/src/schema/` — `organizations`, `accounts`, `journal-entries`, `journal-lines`, `bank-transactions`, `audit-log`.
- Ledger engine: `lib/ledger/src/` — `posting.ts` (postJournalEntry), `reversal.ts` (reverseJournalEntry), `reporting.ts` (account balance, trial balance, P&L, balance sheet), `seed.ts` (starter chart of accounts), `money.ts` (BigInt helpers + normal-balance rules).
- Tests: `lib/ledger/src/ledger.test.ts` — run with `pnpm --filter @workspace/ledger run test`.

## Architecture decisions

- Money is integer minor units in `bigint` columns, surfaced as native JS `BigInt` (`mode: "bigint"`). No float/JS number ever touches a monetary path; inputs that are JS numbers are rejected at runtime.
- Journal entries are immutable and append-only. Corrections are new reversing entries that swap debit/credit and set `reverses_entry_id`; the original is never UPDATEd/DELETEd. Reversal state is derived from that column, not a mutable flag.
- Account balances are always derived by summing journal lines — there is no stored balance column.
- Every table carries `org_id` and every query is scoped by it for tenant isolation. Entry + lines + audit row commit in one DB transaction.
- Balance sheet only closes when current-period net income is folded into equity (`equityWithIncome`), since revenue/expense accounts are not yet closed to retained earnings.

## Product

Built on the Phase 1 ledger core, the engine now offers:

- **Bank/accounting import + reconciliation** (`import.ts`): ingest a QBO/Xero-style
  file of transactions, invoices, and bills; every economic event posts through
  `postJournalEntry`. Idempotent per source `externalId` so re-importing the same
  file posts nothing new. `ReconciliationReport` proves the ledger reproduces the
  source's own trial balance exactly (per-account and in total).
- **Accounts payable** (`ap.ts`): `createBill` (Dr expense / Cr A/P) and `payBill`
  (Dr A/P / Cr cash), with partial payments and derived `open`/`paid` status.
- **Accounts receivable** (`ar.ts`): `createInvoice` (Dr A/R / Cr revenue),
  `payInvoice` (Dr cash / Cr A/R), and `getArAging` bucketing outstanding balances
  into current / 1-30 / 31-60 / 61-90 / 90+.
- **Payroll ingest** (`payroll.ts`): record a provider's finished run (Gusto/Check)
  verbatim as Dr salaries / Cr cash / Cr tax liability. No tax computation — only
  enforces gross = net + taxes so the entry balances. Idempotent per
  (org, provider, externalId).
- **RBAC + accountant collaboration** (`access.ts`): roles owner / staff /
  view_only / accountant with a permission matrix; `addMember`, `inviteAccountant`,
  and `revokeMember` are audit-logged. Membership is revocable via `revokedAt`
  (append-only, never deleted). `listOrgsForUser` returns only orgs a user has a
  live membership in, so an invited accountant sees only granted orgs.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Every automated money path must pass an idempotency key** to `postJournalEntry`.
  The insert is race-safe (`onConflictDoNothing` on `(orgId, idempotencyKey)` +
  reload-the-winner), so concurrent re-runs never double-post.
- **AP/AR/payroll flows are atomic.** Each wraps its document-row insert/update and
  the ledger post in one `db.transaction`, passing `tx` through `postJournalEntry`
  (via `PostOptions.tx`). Never post the ledger entry outside the document
  transaction — that is how you strand a row with a null `postedEntryId`.
- **RBAC is a caller-side gate, not enforced inside money ops.** This is a library
  with no HTTP endpoints; `requirePermission` must be called by whatever layer
  eventually exposes these functions. The service functions themselves do not check
  permissions.
- **Reconciliation compares source vs. ledger trial balance**, not the org's full
  standing trial balance. Prior activity in the same accounts makes the check
  stricter (the ledger must still reproduce the imported file), never falser.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
