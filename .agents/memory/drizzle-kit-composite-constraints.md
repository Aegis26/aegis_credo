---
name: drizzle-kit composite constraints
description: drizzle-kit push quirks with bigint defaults and manually-added composite unique/FK constraints
---

# drizzle-kit push quirks

- **BigInt column defaults break `drizzle-kit push` snapshotting.** `bigint(..., { mode: "bigint" }).default(0n)` makes push throw `Do not know how to serialize a BigInt`. Use `.default(sql\`0\`)` instead.
  - **Why:** drizzle-kit JSON.stringifies the schema snapshot, and BigInt has no JSON serializer.

- **Declare composite UNIQUE columns in table-ordinal order, or `push` false-diffs forever.** drizzle-kit canonicalizes a composite unique constraint's columns by the referenced columns' *ordinal position in the table*, not by the order written in `.on(...)`. So a `(org_id, id)` unique where `id` is column 1 and `org_id` column 2 is introspected as `(id, org_id)`. If the schema declares `.on(t.orgId, t.id)` but the DB stores `(org_id, id)`, push compares its introspected `(id, org_id)` against the declared `(org_id, id)`, sees a mismatch, and tries to *add* the constraint on every run — even though it already exists.
  - **Symptom:** `push` prompts "You're about to add <name> unique constraint … Do you want to truncate?" for a constraint that is already in the DB. Fixing one just moves the prompt to the next identically-shaped constraint (the diff is per-constraint, and push aborts on the first TTY prompt).
  - **Fix (no manual SQL, no data loss, no DDL):** reorder the declaration to match table-ordinal order, e.g. `unique("x_org_id_unique").on(t.id, t.orgId)` for a `(id first, org_id second)` table. This changes only the drizzle text, not the physical constraint; the DB stays `(org_id, id)` and the composite FKs (which drizzle also reads in `(id, org_id)` order) keep matching. After reordering every affected constraint, a plain `db push` reports no changes.
  - **How to apply:** whenever you add a composite `(org_id, id)` tenant-isolation unique in this repo, write `.on(t.id, t.orgId)` from the start. Never reach for `push --force`, `executeSql` DDL, or `DROP SCHEMA` to work around this — those are unnecessary and destructive; the reorder is the whole fix.
