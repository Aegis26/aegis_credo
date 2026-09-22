---
name: Production maintenance CLIs
description: Ensure administrative shell utilities can run in Railway's production image.
---

Any supported operational command intended for the Railway console must be bundled as its own production `dist` entrypoint and invoked with Node.

**Why:** The production image has compiled output but omits the TypeScript source tree and development-only runners such as `tsx`, so source-based CLI instructions fail even when they work locally.

**How to apply:** Add the maintenance program to the server build entrypoints, verify its compiled file exists after a production build, and document the Node command used by operators.