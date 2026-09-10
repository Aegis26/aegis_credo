import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set to run database migrations");
}

const pool = new Pool({ connectionString });
const db = drizzle(pool);
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

try {
  await migrate(db, { migrationsFolder });
} finally {
  await pool.end();
}