import { desc } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { trips } from "@db/schema";

export const tripsRouter = createRouter({
  /** Persist a finished trip. Failures are swallowed so the game never breaks. */
  save: publicQuery
    .input(
      z.object({
        mode: z.enum(["autopilot", "human"]),
        score: z.number().int(),
        distanceM: z.number().int(),
        durationS: z.number().int(),
        decisions: z.number().int(),
        incidents: z.number().int(),
        destinationsReached: z.number().int(),
        crashed: z.boolean(),
        arrived: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await getDb().insert(trips).values({
          mode: input.mode,
          score: input.score,
          distanceM: input.distanceM,
          durationS: input.durationS,
          decisions: input.decisions,
          incidents: input.incidents,
          destinationsReached: input.destinationsReached,
          crashed: input.crashed ? "yes" : "no",
          arrived: input.arrived ? "yes" : "no",
        });
        return { ok: true };
      } catch (err) {
        console.error("Failed to save trip:", err);
        return { ok: false };
      }
    }),

  recent: publicQuery
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ input }) => {
      try {
        const rows = await getDb()
          .select()
          .from(trips)
          .orderBy(desc(trips.createdAt))
          .limit(input.limit);
        return rows;
      } catch (err) {
        console.error("Failed to load trips:", err);
        return [];
      }
    }),
});
