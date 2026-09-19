import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { DECISION_QUESTIONS, TYPESAFE_MODEL } from "@contracts/ai";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export const aiRouter = createRouter({
  /**
   * Proxy to TypeSafe's System One endpoint (Jev). The API key stays
   * server-side; the frontend only sends the perceived world state.
   */
  decide: publicQuery
    .input(z.object({ state: z.unknown() }))
    .mutation(async ({ input }) => {
      const apiKey = process.env.TYPESAFE_API_KEY;
      if (!apiKey) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "TYPESAFE_API_KEY is not configured on the server",
        });
      }

      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(TYPESAFE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: TYPESAFE_MODEL,
            state: input.state,
            questions: DECISION_QUESTIONS,
          }),
        });
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cannot reach TypeSafe API: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      const latencyMs = Date.now() - started;

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `TypeSafe API returned ${res.status}: ${body.slice(0, 300)}`,
        });
      }

      const data: unknown = await res.json();
      if (typeof data !== "object" || data === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unexpected TypeSafe API response shape",
        });
      }
      return { ...(data as Record<string, unknown>), latencyMs };
    }),
});
