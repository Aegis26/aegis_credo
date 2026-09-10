# Railway deployment

This repository deploys as one Railway service. Express serves both `/api` and
the built React single-page application, so sessions remain same-origin and no
CORS configuration is required.

## Commands

- Build: `pnpm run build:production`
- Migrate a fresh or existing database: `pnpm run db:migrate`
- Start: `pnpm start`
- Health check: `/api/healthz`

`railway.toml` runs the versioned Drizzle migrations as Railway's pre-deploy
command. Migrations are not run by application startup.

## Fresh database

1. Create an empty Railway PostgreSQL database.
2. Configure the variables documented in `.env.example`.
3. Run `pnpm run db:migrate` (Railway also runs this in pre-deploy).
4. Provision the configured MASTER ADMIN with the trusted CLI:

   `pnpm --filter @workspace/api-server exec tsx src/create-user.ts <email> <password> [name]`

5. Remove any temporary initial-password secret after provisioning.

The clean-start decision discards only data from the old Replit database. The
application code, schema, versioned migrations, and configuration remain in the
Git repository.

## Required configuration

`NODE_ENV`, `PORT`, `DATABASE_URL`, `SESSION_SECRET`,
`TOKEN_ENCRYPTION_KEY`, `PUBLIC_APP_URL`, `ALLOWED_ORIGINS`, and
`TRUST_PROXY` are required in production. `ANTHROPIC_API_KEY` is required for
statement extraction. `MASTER_ADMIN_EMAIL` is required only when the operator
capability is enabled. Plaid requires `PLAID_CLIENT_ID`, `PLAID_SECRET`, and a
valid `PLAID_ENV` (`sandbox`, `development`, or `production`).

Do not copy test data from Replit into the clean Railway database.