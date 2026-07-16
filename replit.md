# Accounting Core (Ledger Engine) — "Aegis Credo"

A multi-tenant, double-entry accounting platform: ledger engine (lib), authenticated HTTP API, and the Books web UI. Published to production.

## CRITICAL CONSTRAINTS — DO NOT BREAK

### Money & double-entry

- **Money is integer minor units in `bigint` columns** (`mode: "bigint"`, native JS `BigInt`). No float or JS `number` ever touches a monetary path; JS-number inputs are rejected at runtime. The TB import adapter parses amounts (incl. thousands separators and native XLSX numbers) straight to BigInt minor units.
- **Money crosses the API/CSV/Excel boundary as a fixed 2-decimal string** (`formatMoney`), never a JS number — JSON cannot carry BigInt. Never `Number()` a monetary BigInt to emit it. Balance-sheet responses include `totalLiabilitiesAndEquity` so the UI never sums money itself.
- **Posted journal entries are immutable and append-only.** Corrections are new reversing entries that swap debit/credit and set `reverses_entry_id`; the original is never UPDATEd/DELETEd. Reversal state is derived from that column, not a mutable flag. Debits must equal credits — unbalanced entries are rejected.
- **Balances are always derived by summing journal lines** — there is no stored balance column. Balance sheet closes only via `equityWithIncome` (current-period net income folded into equity).
- **Every automated money path must pass an idempotency key** to `postJournalEntry`. The insert is race-safe (`onConflictDoNothing` on `(orgId, idempotencyKey)` + reload-the-winner) so concurrent re-runs never double-post.
- **AP/AR/payroll flows are atomic**: document-row write + ledger post in ONE `db.transaction` (pass `tx` via `PostOptions.tx`). Never post the ledger entry outside the document transaction.

### Identity, tenancy & access

- **Identity is ALWAYS derived server-side from the session** (`getSessionUserId(req)` ← `req.session.userId`). No endpoint accepts a client-supplied `userId`/`orgId` identity field; a spoofed one is ignored and the session wins. `requireAuth` gates every non-auth route (401 before handlers run).
- **Tenancy uses the double-where (`org_id` + `id`) pattern at the service layer.** Every table carries `org_id`; every query is scoped by it. Entry + lines + audit row commit in one transaction.
- **RBAC is a caller-side gate** — the ledger lib performs NO auth; `requirePermission` must be called by the exposing layer (the API does, per route: `reports.read` for reads, `ledger.post` for money ops, `members.manage` for membership/approval admin).
- **Practice access is two independent revocable gates**: ACTIVE `practice_members` row AND ACTIVE `practice_clients` grant (both append-only via `revokedAt`, never deleted). Every practice-layer action over a client's books must go through `assertClientAccess` / `accessibleClients`; batch paths filter with `accessibleClients` first.
- **Saved report definitions are scope-guarded** (`assertDefinitionScope`): a definition may only target its owning org or a group that org belongs to — the stored `orgId/groupId` is attacker-controllable otherwise.
- **`ALLOW_PUBLIC_SIGNUP` fails closed**: signup is enabled only if the value is exactly `"true"`; anything else → 403. `src/create-user.ts` is the shell-only provisioning path (argon2id hash, audit-logged; never an HTTP route).

### Secrets, tokens & sessions

- **`TOKEN_ENCRYPTION_KEY` fails closed** (must decode to 32 bytes; app refuses to start in production without it, mirroring `SESSION_SECRET`). **Plaid access tokens are AES-256-GCM encrypted at rest** (`v1:<iv>:<ct>:<tag>`, fresh IV per encryption, auth-tag verified on decrypt — `src/lib/token-crypto.ts`). Decrypt ONLY at the server-side Plaid sync call; never log the plaintext token or the key; never return a token in an API response.
- **`SESSION_SECRET` is required in production.** Sessions live in Postgres behind an httpOnly + Secure(prod) + SameSite=Lax cookie `sid`; session id is regenerated at login/signup (fixation defense).

### Web/API hardening

- **CSRF is two independent layers**: the SameSite=Lax `sid` cookie AND `src/middlewares/origin-check.ts` — 403 for any state-changing (non-GET/HEAD/OPTIONS) request whose `Origin` host is not in `REPLIT_DOMAINS` + `REPLIT_DEV_DOMAIN` (env-driven, re-read per request; exact loopback hostnames allowed in dev only; no-Origin requests pass). No CORS middleware — same-origin behind the shared proxy; do not re-add `cors()`. Tests: `src/csrf.test.ts`.
- **500 responses return a generic `"Internal error."` and NEVER echo `err.message`** (SQL/driver/SDK detail would leak). Real error is logged server-side. A final error middleware keeps malformed-JSON responses as uniform JSON 400 (no Express HTML/stack pages). `x-powered-by` is disabled. Tests: `src/hardening.test.ts`.
- **Rate limiting**: auth limiter (`AUTH_RATE_LIMIT_MAX`, 50/15 min) + global `/api` limiter (`API_RATE_LIMIT_MAX`, 1000) + stricter heavy-endpoint limiter (`HEAVY_RATE_LIMIT_MAX`, 60: import preview, batch export/report, custom report, consolidated statements). Non-numeric env values fall back to defaults.
- **HTTP logging never includes bodies, headers, or query strings** (pino serializers log method, path, status only) — no PII/financial data/tokens in logs.
- **No uploaded files are ever written to disk** (the former dev capture helper was removed for security). Imports are parsed in memory.

### Import & export

- **Imports are idempotent** per source `externalId` / content — re-importing the same file posts nothing new. **The multi-import guard never stacks opening balances**: a different file with existing un-reversed `import_opening` entries → `ImportOpeningConflictError` (409); `onExistingOpening: "replace"` reverses prior openings (append-only) then posts the new one, all in ONE transaction under `pg_advisory_xact_lock` so concurrent imports serialize.
- **The account-type resolver never silently defaults to Asset** — ambiguous accounts are surfaced (`ambiguous` + `candidateTypes`) for an explicit user choice; the UI disables Import until every one is chosen.
- **`craigs-trial-balance.csv` is the user's VERBATIM QuickBooks export**, a regression fixture — never hand-edit it. Adapter unit tests and the API e2e both parse it with the same exported `csvToRows` the preview endpoint uses.
- **TB adapter strips report scaffolding structurally, never by missing amounts**: TOTAL/footer/blank rows are skipped by pattern (footer patterns apply only when amount cells are empty). Zero-balance / name-only rows are real ACCOUNTS — upserted to the COA, excluded from the opening entry. Unbalanced files get an Opening Balance Equity plug.
- **CSV export sanitizes formula injection** (`sanitizeCsvText` in `lib/ledger/src/export.ts`): leading `=` `+` `@` tab CR are prefixed with `'`; `-` only when the cell is not a plain number. Monetary values are never altered (numeric/bigint bypass). XLSX path untouched.
- **Reconciliation compares NET movement per account** (debits − credits on the natural side), source vs. ledger — netting is what lets "replace" imports reconcile. Never switch back to gross column totals.

### Consolidation & intercompany

- **Consolidation combines by account CODE, not id** (ids differ per org). Combined and elimination sums are keyed on code in lockstep — change one grouping key and you must change the other.
- **Intercompany elimination trusts caller tagging**: tag BOTH legs with `counterpartyOrgId` or consolidated statements drift. **The group must exist first** — `postJournalEntry` rejects `counterpartyOrgId` lines unless both orgs already share a group.
- **Consolidated reads demand `reports.read` on EVERY member org**; attaching an org to a group demands `members.manage` on that org.

### Operational

- **Restart the workflow (dev) / republish (prod) before verifying a change** — a stale server will happily "pass" old code. Workspace state is NOT production state; prod has its own DATABASE_URL, env, and data.
- **Build gotchas**: (a) Orval — endpoints with BOTH path+query params collide on `<Op>Params` between zod client & types; fix via explicit re-export in the api-zod barrel. Never use `format: email` in openapi.yaml (emits zod v4 `zod.email()` against resolved zod v3). (b) Drizzle — declare composite `(org_id, id)` uniques in table-ordinal order (`.on(t.id, t.orgId)`) or `push` false-diffs and prompts to truncate forever.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — API test suite (vitest + supertest)
- `pnpm --filter @workspace/ledger run test` — ledger test suite
- Demos: `pnpm --filter @workspace/ledger run demo:consolidate` / `demo:practice`
- Required env: `DATABASE_URL`; `SESSION_SECRET` (prod); `TOKEN_ENCRYPTION_KEY` (prod, 32 bytes base64)
- Optional env: `AUTH_RATE_LIMIT_MAX` (50), `API_RATE_LIMIT_MAX` (1000), `HEAVY_RATE_LIMIT_MAX` (60), `ALLOW_PUBLIC_SIGNUP` (fail closed, see constraints), `PLAID_CLIENT_ID`/`PLAID_SECRET` (bank features degrade gracefully without them)
- Create a user (invite-only, shell-only): `cd artifacts/api-server && npx tsx src/create-user.ts <email> <password> [name]`. For production, export the production `DATABASE_URL` first.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5; DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`; API codegen: Orval (contract-first from `lib/api-spec/openapi.yaml`)
- UI: React + Vite + wouter + TanStack Query; Build: esbuild (CJS bundle)

## Where things live

- DB schema (source of truth): `lib/db/src/schema/`
- Ledger engine: `lib/ledger/src/` — `posting.ts`, `reversal.ts`, `reporting.ts`, `seed.ts`, `money.ts`, plus domain modules (`import.ts`, `ap.ts`, `ar.ts`, `payroll.ts`, `access.ts`, `consolidation.ts`, `approvals.ts`, `dimensions.ts`, `report-builder.ts`, `budget.ts`, `practice.ts`, `close.ts`, `export.ts`, `batch.ts`, `dashboard.ts`) and `import-adapters/qbo-trial-balance.ts`
- API server: `artifacts/api-server/src/` (routes, middlewares, `lib/auth-service.ts`, `lib/token-crypto.ts`, `lib/errors.ts`)
- Books UI: `artifacts/books/src/` (current-org is a shared React Context — `hooks/use-current-org.tsx` inside the auth guard; never per-component `useState`. Generated client already prefixes `/api`; do NOT `setBaseUrl`.)
- Tests: `lib/ledger/src/*.test.ts`, `artifacts/api-server/src/*.test.ts`

## Product summary (built in phases, condensed)

- **Ledger core**: balancing posting service, immutable reversing corrections, ledger-derived reports (TB / P&L / BS), seeded chart of accounts.
- **Auth**: argon2id passwords, Postgres sessions (`sid` cookie), per-IP rate limit + per-account lockout (5 fails → 15-min lock), every auth event audit-logged to `auth_events`.
- **SMB features**: bank/accounting file import + reconciliation report; AP (bills, partial payments); AR (invoices, payments, aging buckets); payroll ingest (gross = net + taxes, idempotent per provider run); RBAC (owner/staff/view_only/accountant) with revocable memberships.
- **Mid-market**: multi-entity groups + consolidated TB/P&L/BS with intercompany elimination; configurable approval workflows (blocking `payBill` until approved, HTTP 409); reporting dimensions (class/department/location); custom report builder with saved definitions; budgets vs actual.
- **Practice layer** (read-only over client books): practice membership + client grants, month-end close periods with checklist tasks + PBC requests, batch reports/exports across granted clients, cross-client dashboard.
- **Books UI** (`artifacts/books`, previewPath `/`): login/signup, onboarding, dashboard, Plaid bank connect (sandbox), reconciliation, invoicing (state is `open|paid` + separate `sentAt`; no draft/sent enum), reports, tax estimator, import wizard (upload → review ambiguous types → import & reconcile), entities/consolidation, approvals, report builder, budgets, org switcher with create-org dialog. UI holds NO accounting logic or money math.
- **QBO import**: Trial Balance adapter (CSV/XLSX) → preview endpoint (`POST /orgs/:orgId/import/preview`) → frozen `POST /import`; type resolution via keyword map, parent:child inheritance, explicit choice for ambiguous.

## Known gaps

- (none currently tracked)

## User preferences

- Security work follows this loop: read-only investigation report first → explicit approval → implement → show diff + passing tests + architect review.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
