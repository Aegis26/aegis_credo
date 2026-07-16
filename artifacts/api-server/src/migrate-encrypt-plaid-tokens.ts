/**
 * One-time, IDEMPOTENT migration: encrypt any plaintext Plaid access tokens in
 * bank_connections at rest (AES-256-GCM, TOKEN_ENCRYPTION_KEY).
 *
 * Safety:
 * - Backs up (org_id, plaid_access_token) into bank_connections_token_backup
 *   BEFORE touching anything (insert-only; re-runs skip already-backed-up rows).
 * - Only encrypts rows whose value does NOT start with "v1:" — re-running
 *   never double-encrypts.
 * - Each row's new value is verified to round-trip (decrypt === original)
 *   before the UPDATE is committed.
 * - Never prints a token or the key.
 *
 * Usage: cd artifacts/api-server && npx tsx src/migrate-encrypt-plaid-tokens.ts
 * (For production, export the production DATABASE_URL first.)
 */
import { sql } from "drizzle-orm";
import { db, pool, bankConnectionsTable } from "@workspace/db";
import {
  encryptToken,
  decryptToken,
  isEncryptedToken,
  parseTokenKey,
} from "./lib/token-crypto";

async function main(): Promise<void> {
  parseTokenKey(process.env.TOKEN_ENCRYPTION_KEY); // fail fast, fail closed

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bank_connections_token_backup (
      connection_id uuid PRIMARY KEY,
      org_id uuid NOT NULL,
      plaid_access_token text NOT NULL,
      backed_up_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const rows = await db.select().from(bankConnectionsTable);
  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (isEncryptedToken(row.plaidAccessToken)) {
      skipped++;
      continue;
    }
    // Backup first (idempotent: keep the earliest pre-migration value).
    await db.execute(sql`
      INSERT INTO bank_connections_token_backup (connection_id, org_id, plaid_access_token)
      VALUES (${row.id}, ${row.orgId}, ${row.plaidAccessToken})
      ON CONFLICT (connection_id) DO NOTHING
    `);
    const enc = encryptToken(row.plaidAccessToken);
    if (decryptToken(enc) !== row.plaidAccessToken) {
      throw new Error(`Round-trip verification failed for connection ${row.id}`);
    }
    await db.execute(sql`
      UPDATE bank_connections
      SET plaid_access_token = ${enc}
      WHERE id = ${row.id} AND plaid_access_token NOT LIKE 'v1:%'
    `);
    encrypted++;
  }

  console.log(
    `Done. ${encrypted} token(s) encrypted, ${skipped} already encrypted, ${rows.length} total connection(s). Backup table: bank_connections_token_backup.`,
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
