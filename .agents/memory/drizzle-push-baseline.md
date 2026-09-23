---
name: Drizzle push baseline
description: How to handle generated migrations against an existing database without a Drizzle migration history.
---

The development database has preexisting tables but no `drizzle.__drizzle_migrations` history. Do not assume the generated baseline migration can be replayed against it; it would attempt to recreate existing tables.

**Why:** This was observed while adding machine credentials. Applying only additive migrations to development worked, while a regular migrate command would start with the baseline. A text-array-to-JSONB migration also required an explicit `USING to_jsonb(...)` conversion.

**How to apply:** Before running migrations in any environment, inspect its actual schema and migration history. Reconcile an existing baseline deliberately; do not use a broad forced push or run the entire journal blind, especially in production. New additive migrations must be checked against the current column types.