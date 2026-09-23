import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

export const machineCredentialsTable = pgTable(
  "machine_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizationsTable.id),
    name: text("name").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    notes: text("notes"),
    keyHash: text("key_hash").notNull(),
    createdBy: uuid("created_by").notNull().references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("machine_credentials_key_hash_unique").on(t.keyHash),
    index("machine_credentials_org_idx").on(t.orgId),
    index("machine_credentials_active_idx").on(t.orgId, t.revokedAt),
  ],
);

export const machineAuditTable = pgTable("machine_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizationsTable.id),
  credentialId: uuid("credential_id").references(() => machineCredentialsTable.id),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id),
  action: text("action").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: text("status").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMachineCredentialSchema = createInsertSchema(machineCredentialsTable).omit({
  id: true, createdAt: true, keyHash: true, lastUsedAt: true, revokedAt: true,
});
export type InsertMachineCredential = z.infer<typeof insertMachineCredentialSchema>;
export type MachineCredential = typeof machineCredentialsTable.$inferSelect;
export type MachineAudit = typeof machineAuditTable.$inferSelect;