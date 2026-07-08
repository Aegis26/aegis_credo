---
name: RHF empty-string defaults vs nullish-coalescing fallbacks
description: react-hook-form optional fields default to "" and are SENT as empty strings; server `??` fallbacks don't catch them and 500.
---

react-hook-form forms initialize optional fields to `""` in `defaultValues`, and
the whole form object is submitted — so optional fields the user left blank arrive
at the API as empty strings, not omitted/undefined.

If a server route resolves a default with nullish coalescing
(`body.someId ?? (await lookupDefault()).id`), an empty string is NOT null/undefined,
so `""` passes through and gets used as a real id → downstream FK/lookup failure → 500.

**Why:** it manifested as an intermittent-looking 500 on invoice create that a
plain `curl` (which omitted the optional field) could not reproduce — only the UI,
which sent `revenueAccountId: ""`, triggered it.

**How to apply:** for optional id/string fields that fall back to a default, use
`||` (or explicitly coerce `"" → undefined`) on the server, not `??`. Better yet,
strip empty-string optionals before sending from the client. When a bug reproduces
via the UI but not via curl, suspect empty-string form fields the curl omitted.
