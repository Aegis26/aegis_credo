import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** Platform-only immutable audit trail; deliberately never scoped to an org. */
export const platformAuditLogTable = pgTable(
  "platform_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => usersTable.id),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    outcome: text("outcome").notNull(),
    requestId: text("request_id"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("platform_audit_actor_created_idx").on(t.actorUserId, t.createdAt),
    index("platform_audit_action_created_idx").on(t.action, t.createdAt),
  ],
);
export type PlatformAuditLog = typeof platformAuditLogTable.$inferSelect;