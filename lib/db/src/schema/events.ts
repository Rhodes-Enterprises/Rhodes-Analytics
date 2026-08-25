import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sitesTable } from "./sites";

export const eventsTable = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sitesTable.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    referrer: text("referrer"),
    visitorId: text("visitor_id").notNull(),
    browser: text("browser"),
    os: text("os"),
    deviceType: text("device_type"),
    country: text("country"),
    durationSeconds: integer("duration_seconds"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("events_site_occurred_idx").on(table.siteId, table.occurredAt),
  ],
);

export const insertEventSchema = createInsertSchema(eventsTable).omit({
  id: true,
});
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof eventsTable.$inferSelect;
