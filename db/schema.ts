import {
  mysqlTable,
  mysqlEnum,
  serial,
  timestamp,
  int,
  // bigint,
} from "drizzle-orm/mysql-core";

// TODO: Add your tables here. See docs/Database.md for schema examples and patterns.
//
// Example:
// export const posts = mysqlTable("posts", {
//   id: serial("id").primaryKey(),
//   title: varchar("title", { length: 255 }).notNull(),
//   content: text("content"),
//   createdAt: timestamp("created_at").notNull().defaultNow(),
// });
//
// Note: FK columns referencing a serial() PK must use:
//   bigint("columnName", { mode: "number", unsigned: true }).notNull()

// A finished (or crashed) autonomous trip, persisted for the "recent trips" panel.
export const trips = mysqlTable("trips", {
  id: serial("id").primaryKey(),
  mode: mysqlEnum("mode", ["autopilot", "human"]).notNull().default("autopilot"),
  score: int("score").notNull(),
  distanceM: int("distance_m").notNull(),
  durationS: int("duration_s").notNull(),
  decisions: int("decisions").notNull(),
  incidents: int("incidents").notNull(),
  destinationsReached: int("destinations_reached").notNull(),
  crashed: mysqlEnum("crashed", ["yes", "no"]).notNull().default("no"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
