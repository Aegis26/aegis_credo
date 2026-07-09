---
name: API zod response-shape drift is runtime-only
description: Why a renamed/wrong key in a server response object passes typecheck but 500s at runtime, and how to avoid it.
---

Server routes build a plain object and validate it with `<Op>Response.parse(...)`
from `@workspace/api-zod` before `res.json`. That parse is a **runtime** check —
TypeScript does not type the argument against the schema, so a response object
with a wrong or renamed key compiles cleanly and only throws (500) when the route
is actually hit.

**Real incident:** the payroll list route emitted `{ runs: [...] }` while the
OpenAPI/zod schema field was `payrollRuns`. Full typecheck passed; the endpoint
would have 500'd at runtime. Caught only by exercising the route.

**Why:** the boundary is contract-first (OpenAPI → codegen → zod + hooks). The zod
response schema is the source of truth; the hand-written response object is not
type-linked to it.

**How to apply:**
- When you add or rename a field in `openapi.yaml`, re-run codegen and update every
  server route's response object keys in lockstep with the generated schema.
- Don't trust `pnpm run typecheck` to catch response-shape drift — it can't. Add or
  run an integration test that hits the endpoint (the api-server vitest suite), or
  curl it against a live session, before considering the route done.
- The frontend consumes the same generated model types, so a server/schema mismatch
  also surfaces as a books typecheck error on `data?.<field>` — that's often the
  first visible symptom.
