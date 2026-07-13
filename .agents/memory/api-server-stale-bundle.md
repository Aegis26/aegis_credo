---
name: API server serves a one-shot build
description: The api-server dev workflow bundles once at startup; lib/* edits are invisible until the workflow restarts.
---

The api-server dev workflow runs `build && start` — esbuild bundles everything (including all `lib/*` code) into `dist/index.mjs` exactly once at startup. There is no watch mode.

**Why:** An adapter fix passed the full test suite yet the running app still served the old behavior for ~an hour, because the server was never restarted after the lib edit. Vitest runs from source, so green tests prove nothing about the running server.

**How to apply:** After editing any code the API server depends on (`lib/ledger`, `lib/db`, api-server sources), restart the "artifacts/api-server: API Server" workflow before verifying in the app or telling the user it's fixed. To check for staleness: compare `dist/index.mjs` mtime against the edited source's mtime, or grep the bundle for a new code pattern (comments are stripped by esbuild — grep for code, not comments).
