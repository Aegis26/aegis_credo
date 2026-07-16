/**
 * Shell-only admin CLI: provision a user account. Public signup is disabled
 * (ALLOW_PUBLIC_SIGNUP fails closed), so this is the supported way to create
 * accounts. NEVER import this from any router or HTTP handler.
 *
 * Usage:
 *   npx tsx src/create-user.ts <email> <password> [name]
 *
 * Uses the same signup() service as the former endpoint: argon2id hash,
 * duplicate-email rejection, and an audit row in auth_events.
 */
import { pool } from "@workspace/db";
import { signup } from "./lib/auth-service";

async function main(): Promise<void> {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Usage: npx tsx src/create-user.ts <email> <password> [name]");
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exitCode = 1;
    return;
  }
  try {
    const user = await signup({ email, password, name, ip: "cli" });
    console.log(`Created user ${user.email} (id ${user.id})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
