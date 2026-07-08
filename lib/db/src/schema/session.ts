import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

// Server-side session store for `connect-pg-simple`. The shape matches what
// connect-pg-simple expects (sid / sess / expire). It is defined here so that
// `drizzle-kit push` owns the table and stays diff-clean; connect-pg-simple is
// configured with `createTableIfMissing: false` and only reads/writes rows.
export const sessionTable = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
  },
  (t) => [index("IDX_session_expire").on(t.expire)],
);
