import { pgTable, uuid, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { practicesTable } from "./practices";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// The explicit, revocable grant that lets a practice access a client org's
// books. This is THE access boundary: a practice user sees a client only when an
// active row exists here for their practice. Revoked by setting revokedAt
// (append-only for audit). Every grant/revoke is audit-logged against the
// client org.
export const practiceClientsTable = pgTable(
  "practice_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practicesTable.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    grantedBy: uuid("granted_by").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("practice_clients_practice_org_unique").on(t.practiceId, t.orgId),
  ],
);

export const insertPracticeClientSchema = createInsertSchema(
  practiceClientsTable,
).omit({ id: true, createdAt: true });
export type InsertPracticeClient = z.infer<typeof insertPracticeClientSchema>;
export type PracticeClient = typeof practiceClientsTable.$inferSelect;
