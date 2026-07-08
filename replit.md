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

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
