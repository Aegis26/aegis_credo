---
name: Orval zod string-format pitfall
description: Why OpenAPI `format: email` (and similar) breaks orval's generated zod client in this repo
---

# Orval zod string-format pitfall

Do NOT put `format: email` (or other string formats orval maps to top-level zod
helpers) on request/response schemas in `lib/api-spec/openapi.yaml`. Orval's zod
generator emits `zod.email()` — a **zod v4** top-level API — but the resolved
runtime is `zod@3.x` (the generated client does `import * as zod from 'zod'`),
so `typecheck:libs` fails with `Property 'email' does not exist on type typeof zod`.

**Why:** the repo pins zod v3 for the generated orval client while app schema
files use `zod/v4` explicitly. Orval assumes v4's flat API for formats.

**How to apply:** keep plain `type: string` in the spec and enforce format in
handler code if needed. `minLength`/`maxLength` are safe — they map to
`.min()/.max()` which exist in both zod majors.
