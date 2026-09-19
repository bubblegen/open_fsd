import { createRouter, publicQuery } from "./middleware";
import { aiRouter } from "./ai-router";
import { tripsRouter } from "./trips-router";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),

  ai: aiRouter,
  trips: tripsRouter,
});

export type AppRouter = typeof appRouter;
