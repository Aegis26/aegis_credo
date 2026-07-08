import { pgTable, uuid, text, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A person who can be granted access to one or more organizations. External
// accountants are ordinary users too — their access is expressed via a
// membership with the "accountant" role, not a separate user type.
//
// Auth columns live here too: a user authenticates with email + password.
// `passwordHash` is nullable so users created by the ledger core (via
// `upsertUser`, which never sets a password) remain valid — they simply cannot
// log in until a password is set. `failedLoginCount` / `lockedUntil` drive the
// backoff/lockout after repeated failed logins.
export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("users_email_unique").on(t.email)],
);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
