import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Append-only audit trail for authentication events (signup, login, logout,
// failed login, lockout). Kept separate from `audit_log` because auth events
// are not org-scoped — `audit_log.org_id` is NOT NULL — and a failed login may
// have no known user at all. `userId`/`email` are therefore both nullable.
export const authEventsTable = pgTable("auth_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => usersTable.id),
  email: text("email"),
  event: text("event").notNull(),
  ip: text("ip"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAuthEventSchema = createInsertSchema(authEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAuthEvent = z.infer<typeof insertAuthEventSchema>;
export type AuthEvent = typeof authEventsTable.$inferSelect;
