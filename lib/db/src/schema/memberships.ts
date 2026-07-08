import {
  pgTable,
  uuid,
  timestamp,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Roles gate what a member may do within an org (see access.ts permission
// matrix). "accountant" is the external-collaborator role: read/report access
// that is granted per-org and can be revoked.
export const membershipRoleEnum = pgEnum("membership_role", [
  "owner",
  "staff",
  "view_only",
  "accountant",
]);

// Every membership is scoped to exactly one org. Access is revoked by setting
// revokedAt (append-only style: the row is kept for audit, never deleted).
export const membershipsTable = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    role: membershipRoleEnum("role").notNull(),
    invitedBy: uuid("invited_by").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Null = active. Set to a timestamp when access is revoked.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [unique("memberships_org_user_unique").on(t.orgId, t.userId)],
);

export const insertMembershipSchema = createInsertSchema(membershipsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMembership = z.infer<typeof insertMembershipSchema>;
export type Membership = typeof membershipsTable.$inferSelect;
export type MembershipRole = (typeof membershipRoleEnum.enumValues)[number];
