---
name: Railway pnpm reproducibility
description: Prevent Railway Railpack from selecting a pnpm version incompatible with this workspace lockfile.
---

Keep the root package-manager version pinned to the same pnpm major used to generate the lockfile.

**Why:** Railway Railpack can otherwise choose its own pnpm default. A pnpm 10 lockfile may then fail under pnpm 9 with an overrides-configuration mismatch before the application build starts.

**How to apply:** When changing pnpm versions, update the root pin and lockfile together, then verify a frozen install using that exact pinned version before deploying.