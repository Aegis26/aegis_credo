import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// An accounting practice / firm that serves multiple client organizations. The
// practice has no ledger of its own — it is a collaboration layer that sits ON
// TOP of independent client books. Access to each client is granted explicitly
// (see practice_clients) and every client-scoped action stays scoped to that
// client's org and audit trail.
export const practicesTable = pgTable("practices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertPracticeSchema = createInsertSchema(practicesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPractice = z.infer<typeof insertPracticeSchema>;
export type Practice = typeof practicesTable.$inferSelect;
