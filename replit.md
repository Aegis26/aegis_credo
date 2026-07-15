# Accounting Core (Ledger Engine)

A multi-tenant, double-entry ledger engine: schema, a balancing posting service, immutable reversing corrections, ledger-derived reports, and an automated test suite. No UI in this task.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — run the API auth test suite (vitest + supertest)
- `pnpm --filter @workspace/ledger run test` — run the ledger test suite
- Required env: `DATABASE_URL` — Postgres connection string; `SESSION_SECRET` — session cookie signing secret (required in production)
- Optional env: `AUTH_RATE_LIMIT_MAX` — max auth requests per IP per 15-min window (default 50)

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

- **Authentication** (`artifacts/api-server`): real, server-verified auth over
  the HTTP API. `/auth/signup`, `/auth/login`, `/auth/logout`, `/auth/session`.
  Passwords are hashed with argon2id (`src/lib/auth-service.ts`); sessions live
  in Postgres (`connect-pg-simple`, `session` table) behind an httpOnly + Secure
  (prod) + SameSite=lax cookie named `sid` (`express-session`). `requireAuth`
  (`src/middlewares/auth.ts`) gates every non-auth route with a `401`. Login has
  per-IP rate limiting (`express-rate-limit`) and per-account lockout (5 failures
  → 15-min lock). Every auth event (signup/login/logout/failed/locked) is written
  to the `auth_events` table. `createApp({ authRateLimitMax })` is a factory so
  tests can inject a low rate limit. Tests: `src/app.test.ts` (session gate,
  IDOR regression, lockout, rate limit, audit).

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

Phase 3 builds multi-entity and analytics features on the same core (all
READ-ONLY over entity ledgers except approvals, which gate an existing money op):

- **Multi-entity groups + consolidation** (`consolidation.ts`): `createGroup`,
  `addOrgToGroup`, `listOrgsInGroup`, and read-only `getConsolidated{TrialBalance,
  ProfitAndLoss,BalanceSheet}`. Combines each entity's ledger by account **code**
  (ids differ per org), then eliminates intercompany activity — lines whose
  `counterpartyOrgId` is another group member — so the group only reflects
  transactions with the outside world. Demo: `pnpm --filter @workspace/ledger run
  demo:consolidate`.
- **Configurable approval workflows** (`approvals.ts`): `createApprovalRule`
  (e.g. bills at/above a threshold need sign-off), `evaluateApproval` (creates a
  pending approval, idempotent per (org, entityType, entityId)), `decideApproval`,
  and `requireApproved`. Wired into AP: `createBill` opens a pending approval when
  a rule applies; `payBill` calls `requireApproved` and throws
  `ApprovalRequiredError` until it is granted. All transitions audit-logged.
- **Reporting dimensions** (`dimensions.ts`): class / department / location tags
  on journal lines (`createDimension` idempotent per (org, type, name)). Lines
  also carry `counterpartyOrgId` for intercompany.
- **Custom report builder** (`report-builder.ts`): `runReport` groups posted lines
  by account / accountType / class / department / location / entity and filters by
  date / type / dimension; scope is exactly one of `orgId` or a `groupId`. Every
  line is counted once (untagged → "(unassigned)"), so debit/credit totals always
  reconcile to the trial balance. `saveReportDefinition` / `runSavedReport`
  persist and re-run queries.
- **Budget vs actual** (`budget.ts`): `createBudget`, `setBudgetLine` (idempotent
  per (org, budget, account)), and `getBudgetVsActual` — actuals are the ledger's
  natural balance over the budget's period window; variance = actual − budgeted.

Phase 4 adds the accountant / PRACTICE layer ON TOP of client books (all
READ-ONLY over client ledgers — no direct ledger writes):

- **Practice access + client switcher** (`practice.ts`): `createPractice`,
  `addPracticeMember` / `revokePracticeMember`, `grantClientAccess` /
  `revokeClientAccess`, `listClientsForPracticeUser` (the switcher/list),
  `hasClientAccess` / `assertClientAccess` / `accessibleClients`, and audited
  `switchToClient`. A user sees a client iff they have an ACTIVE practice
  membership AND an ACTIVE client grant; both are revocable (append-only
  `revokedAt`). Grant/revoke/switch are audit-logged against the client org.
- **Month-end close** (`close.ts`): per-client close periods with a status
  lifecycle (`open`/`in_progress`/`in_review`/`closed`), checklist tasks
  (`addCloseTask` / `setCloseTaskStatus`), and a PBC request list the client
  responds to (`createPbcRequest` → `respondPbcRequest` → `acceptPbcRequest`).
  `getCloseStatus` derives progress from the tasks; nothing is stored.
- **Export** (`export.ts`): pure serialization (no DB, no deps). `Sheet` /
  `Workbook` types, `formatMoney` (BigInt minor units → decimal string), `toCsv`
  (RFC-4180), `toSpreadsheetXml` (multi-sheet Excel-openable SpreadsheetML), and
  `serializeWorkbook` (CSV-per-sheet or one Excel file).
- **Batch ops** (`batch.ts`): `runBatchReport` / `batchExport` run the same
  report across a book of clients, scoped via `accessibleClients` first (an
  ungranted client is rejected, or dropped with `skipUnauthorized`). Export is
  audited per client (`practice.client.export`).
- **Practice dashboard** (`dashboard.ts`): `getPracticeDashboard` — cross-client
  close progress + headline financials for every granted client.
- **API** (`artifacts/api-server`): `/practice/clients`, `/practice/dashboard`,
  `/practice/batch-export`, `/clients/:orgId/close-periods[/:periodId/status]`.
  Contract-first via `lib/api-spec/openapi.yaml` → codegen. Money is serialized
  as decimal strings at the API boundary (JSON has no BigInt). Demo:
  `pnpm --filter @workspace/ledger run demo:practice`.

Phase 5B adds a freelancer-facing web UI (`artifacts/books`, previewPath `/`)
on top of the authenticated API — the UI holds NO accounting logic, only calls
session-authenticated, org-scoped endpoints:

- **UI** (`artifacts/books`): React + Vite + wouter + TanStack Query, forest-green
  theme. Screens: login/signup, onboarding (create org + seed COA), dashboard,
  bank connect (Plaid Link sandbox), reconciliation, invoicing, reports
  (P&L/BS/TB), tax estimator. Current-org is a shared React Context
  (`hooks/use-current-org.tsx`, `CurrentOrgProvider` inside the auth guard) — never
  per-component `useState`, or isolated instances read `orgId=null`. The generated
  client already prefixes `/api` (OpenAPI `servers.url:/api`); do NOT `setBaseUrl`.
  Books is same-origin with the API so the `sid` session cookie is auto-sent.
- **Thin API wrappers** (`artifacts/api-server`): `/orgs` (list/create+seed),
  `/orgs/:orgId/{dashboard,accounts,invoices,reports/*,tax-estimate,bank/*}`.
  Every route gates on `requireAuth` + `requirePermission` (reports.read for reads,
  ledger.post for money ops); identity is session-derived, never client-supplied.
  Money serialized as decimal strings. Invoice state is `open|paid` plus a separate
  `sentAt` timestamp (there is no `draft`/`sent` status enum). Balance sheet
  response includes `totalLiabilitiesAndEquity` so the UI never sums money itself.
- **Plaid is optional**: without `PLAID_CLIENT_ID`/`PLAID_SECRET`, `bank/status`
  returns `configured:false` and `bank/link-token` returns 503; the UI degrades to
  a "not set up" message.

Phase 6 adds a vendor-export ADAPTER layer in front of the frozen import engine
(`import.ts` unchanged):

- **QBO Trial Balance adapter** (`lib/ledger/src/import-adapters/
  qbo-trial-balance.ts`): parses a QuickBooks Trial Balance export (CSV or XLSX
  cell grid) into the canonical `ImportFileInput`. Preamble/company detection,
  TOTAL-row skipping, thousands separators and native XLSX numbers parsed to
  BigInt minor units (no float). Type resolution: precedence-ordered keyword
  map (`mapped`), QBO colon `parent:child` hierarchy inheritance resolved
  root-first (`inherited`), and `ambiguous` accounts surfaced for an explicit
  user choice — never silently defaulted. Zero-balance rows (name only / 0.00)
  are real accounts: upserted to the COA, excluded from the opening entry.
  Unbalanced files get an Opening Balance Equity plug.
- **Preview endpoint** (`POST /orgs/:orgId/import/preview`,
  `import-preview.ts`): parse + resolve without posting; returns accounts with
  `typeSource`/`candidateTypes`, totals, `ambiguousCount`, and the canonical
  `draft` to post to the frozen `POST /import`.
- **UI wizard** (`artifacts/books/src/pages/import.tsx`): upload → review
  (ambiguous accounts start with an EMPTY type dropdown; Import is disabled
  until every one has an explicit choice) → import & reconcile.
- Tests: the committed fixture
  (`lib/ledger/src/import-adapters/fixtures/craigs-trial-balance.csv`) is the
  user's ACTUAL QuickBooks export captured VERBATIM from an app upload — never
  hand-edit it. Both the adapter unit suite (`qbo-trial-balance.test.ts`) and
  the API e2e (`phase6.test.ts`) read it via `readFileSync` and parse it with
  the same exported `csvToRows` (papaparse, now in `@workspace/ledger`) the
  preview endpoint uses, asserting account TYPES and DB state, not just
  balance.

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

- **Consolidation combines by account CODE, not id** — account ids differ per
  entity, so `consolidation.ts` merges and eliminates strictly by code. Both the
  combined and elimination sums are keyed on code in lockstep; if you change one
  grouping key, change the other or elimination silently mispairs.

- **Intercompany elimination trusts caller tagging.** Consolidation removes every
  line whose `counterpartyOrgId` is another group member. It does NOT verify that
  both legs of an intercompany transaction were tagged consistently — tag both
  sides (payer and payee entries) with the counterparty org, or the consolidated
  P&L/BS will drift even though each entity's ledger still balances.

- **Saved report definitions are scope-guarded.** A definition owned by an org may
  only target that org or a group it belongs to; `saveReportDefinition` and
  `runSavedReport` both call `assertDefinitionScope` and throw `ForbiddenError`
  otherwise. Never bypass this — the stored `definition.orgId/groupId` is
  attacker-controllable and would otherwise read another tenant's ledger.

- **Practice access is two independent revocable gates.** A practice user sees a
  client iff they have an ACTIVE `practice_members` row AND an ACTIVE
  `practice_clients` grant. Both are append-only (`revokedAt`), never deleted.
  Revoking either hides the client. Every practice-layer read/action over a
  client's books must call `assertClientAccess` / `accessibleClients` first — the
  ledger core performs NO auth. Batch paths filter via `accessibleClients` before
  touching any client.

- **The HTTP API authenticates via server-side sessions; identity is NEVER
  client-supplied.** `requireAuth` rejects any request without a valid session
  (`401`) before handlers run, and route handlers read the caller via
  `getSessionUserId(req)` (from `req.session.userId`, set server-side at
  login/signup). No endpoint accepts a `userId` param/body field — the OpenAPI
  spec has none, so a spoofed `?userId=` is simply ignored and the session
  identity wins. The ledger core still performs NO auth: the API layer is the
  gate, and tenant scoping (`assertClientAccess`, `accessibleClients`) runs on
  top of the authenticated identity, not instead of it.

- **TB adapter strips report scaffolding STRUCTURALLY, never by missing
  amounts.** TOTAL/subtotal rows, blank rows, and the QuickBooks report FOOTER
  ("Accrual Basis <timestamp>", "Cash Basis …", weekday/GMT timestamp lines) are
  skipped by pattern — and footer patterns only apply when the amount cells are
  empty, so a real account that resembles a footer but carries a balance
  survives. Zero-balance accounts must never be filtered by "has no amounts".
  Dev-only: every preview upload is captured to
  `artifacts/api-server/import-uploads/` (gitignored) so a real export can be
  promoted to a test fixture verbatim.

- **TB adapter treats name-only rows as zero-balance ACCOUNTS, not section
  headers.** QuickBooks lists zero-balance accounts with blank amounts (e.g.
  "Arizona Dept. of Revenue Payable"), so the adapter keeps them — upserted to
  the chart of accounts but excluded from the opening journal entry (a zero
  line would be rejected by the posting service). A TB export that contains
  decorative section headings would import them as zero-balance accounts; this
  is a deliberate tradeoff in favor of never dropping real accounts.

- **Money crosses the API/CSV boundary as a decimal string, never a JS number.**
  JSON and JS `number` cannot carry BigInt safely, so `formatMoney` renders minor
  units to a fixed 2-decimal string at every serialization boundary (API
  responses, CSV, Excel). Never `Number()` a monetary BigInt to emit it.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
