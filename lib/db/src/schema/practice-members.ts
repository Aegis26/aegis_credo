import { pgTable, uuid, timestamp, pgEnum, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { practicesTable } from "./practices";
import { usersTable } from "./users";

// Practice staff. Membership decides who may act on behalf of the practice; it
// does NOT by itself grant access to any client — a user only ever sees a client
// their practice was explicitly granted (practice_clients). Revocable via
// revokedAt (append-only: the row is kept, never deleted).
export const practiceRoleEnum = pgEnum("practice_role", ["owner", "staff"]);

export const practiceMembersTable = pgTable(
  "practice_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practicesTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    role: practiceRoleEnum("role").notNull().default("staff"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("practice_members_practice_user_unique").on(t.practiceId, t.userId),
  ],
);

export const insertPracticeMemberSchema = createInsertSchema(
  practiceMembersTable,
).omit({ id: true, createdAt: true });
export type InsertPracticeMember = z.infer<typeof insertPracticeMemberSchema>;
export type PracticeMember = typeof practiceMembersTable.$inferSelect;
export type PracticeRole = (typeof practiceRoleEnum.enumValues)[number];
