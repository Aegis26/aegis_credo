---
name: Orval params name collision
description: Why the api-zod barrel needs explicit re-exports when an endpoint has both path and query params
---

When an OpenAPI operation has BOTH path params and query params, orval emits a
`<Op>Params` symbol in TWO generated outputs at once:

- the **zod client** (`lib/api-zod/src/generated/api.ts`) emits `<Op>Params` as
  the zod validator for the **path** params (plus a separate `<Op>QueryParams`).
- the **types package** (`lib/api-zod/src/generated/types/`) emits `<Op>Params`
  as a TS type merging path + query.

The hand-written barrel `lib/api-zod/src/index.ts` does
`export * from "./generated/api"; export * from "./generated/types";`, so the two
star exports collide and `tsc` fails with TS2308 ("already exported a member
named '<Op>Params'"). Query-only or path-only operations do NOT collide (zod
names them `<Op>QueryParams`).

**Fix:** in the barrel, after the two `export *` lines, add an explicit
`export { <Op>Params, ... } from "./generated/api";` for each colliding op. An
explicit named re-export wins over both star exports; the merged type alias from
the types package is simply shadowed (it was unused).

**Why:** the barrel is hand-authored (survives `codegen`'s `clean`), so the fix
lives there, not in generated files. Every new path+query endpoint adds a new
colliding name — extend that explicit re-export list when you add one.
