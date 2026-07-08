---
name: drizzle-kit composite constraints
description: drizzle-kit push quirks with bigint defaults and manually-added composite unique/FK constraints
---

# drizzle-kit push quirks

- **BigInt column defaults break `drizzle-kit push` snapshotting.** `bigint(..., { mode: "bigint" }).default(0n)` makes push throw `Do not know how to serialize a BigInt`. Use `.default(sql\`0\`)` instead.
  - **Why:** drizzle-kit JSON.stringifies the schema snapshot, and BigInt has no JSON serializer.

- **`drizzle-kit push` orders composite FK creation before the referenced composite UNIQUE, so it fails with `there is no unique constraint matching given keys`.** When you need composite `(org_id, id)` UNIQUE + composite FKs (e.g. tenant-isolation FKs), add them by hand via `executeSql` in order (uniques first, then FKs) on empty tables, rather than relying on push.
  - After manual creation, push may still show a cosmetic drop/recreate diff for those constraints (`cannot drop constraint ... because other objects depend on it`). The DB is correct; verify with `pg_get_constraintdef` and trust the tests over push convergence.
  - **How to apply:** any schema needing multi-column FKs added to existing tables in this repo.
