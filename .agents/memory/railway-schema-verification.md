---
name: Railway schema verification
description: Distinguish Railway code inspection from actual production database introspection.
---

Do not treat the Railway agent's description of tables or migration history as a live database check unless it explicitly ran SQL against the running Postgres service. Its available inspection tools may only read the GitHub repository or container files, even when its answer initially sounds like a schema query.

**Why:** A production inspection reported tables absent and migration history from a committed snapshot; on follow-up the agent acknowledged it had no SQL-execution capability and had not queried Postgres. A separate internal-database query found the actual journal state.

**How to apply:** Before any Railway production schema write, use an authenticated connection to the intended Postgres service to inspect real tables and journal entries. Never replay the baseline based on GitHub snapshots alone. Verify the resulting tables and journal from a fresh connection.