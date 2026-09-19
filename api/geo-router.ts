import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import type { GeoPlace, RouteData, RouteStep } from "@contracts/geo";

const UA = "tesla-autopilot-sim/1.0 (TypeSafe Jev driving demo)";
const PHOTON = "https://photon.komoot.io/api/";
const OSRM = "https://router.project-osrm.org/route/v1/driving";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Egress from the deployed container to public routing APIs is occasionally
 *  flaky (~1 in 5 fetches dies at connection level). One retry is usually
 *  enough; after 4 attempts the error is real, not transient. */
async function fetchJson(url: string): Promise<unknown> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) return res.json();
      const body = await res.text().catch(() => "");
      // 429/5xx may be transient too (demo servers rate-limit); retry those
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Upstream ${new URL(url).host} returned ${res.status}: ${body.slice(0, 200)}`,
      });
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      lastErr = err;
      if (attempt < 3) await sleep(400 * (attempt + 1));
    }
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `No se pudo contactar con ${new URL(url).host} tras varios intentos: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  });
}

/** Successful routes cached in memory: if the user retries after a flake,
 *  the second click answers instantly without touching the network. */
const routeCache = new Map<string, unknown>();
const ROUTE_CACHE_MAX = 200;
function cacheKey(tag: string, coords: string): string {
  return `${tag}:${coords}`;
}

export const geoRouter = createRouter({
  /** Forward geocoding via Photon (open, keyless). */
  geocode: publicQuery
    .input(z.object({ q: z.string().min(2).max(200) }))
    .query(async ({ input }) => {
      const key = cacheKey("geocode", input.q.trim().toLowerCase());
      const hit = routeCache.get(key);
      if (hit) return hit;
      const url = `${PHOTON}?q=${encodeURIComponent(input.q)}&limit=6`;
      const data = (await fetchJson(url)) as {
        features?: Array<{
          geometry?: { coordinates?: [number, number] };
          properties?: {
            name?: string;
            street?: string;
            housenumber?: string;
            city?: string;
            county?: string;
            state?: string;
            country?: string;
            osm_key?: string;
            osm_value?: string;
          };
        }>;
      };
      const places: GeoPlace[] = (data.features ?? []).flatMap((f) => {
        const [lon, lat] = f.geometry?.coordinates ?? [0, 0];
        const p = f.properties ?? {};
        if (!lat || !lon) return [];
        const parts = [
          p.name ?? p.street ?? "",
          p.housenumber,
          p.city ?? p.county,
          p.country,
        ].filter(Boolean);
        return [
          {
            id: `${p.osm_key}:${p.osm_value}:${lat.toFixed(5)}:${lon.toFixed(5)}`,
            name: parts.join(", "),
            lat,
            lon,
          },
        ];
      });
      if (routeCache.size >= ROUTE_CACHE_MAX) {
        const firstKey = routeCache.keys().next().value;
        if (firstKey !== undefined) routeCache.delete(firstKey);
      }
      routeCache.set(key, places);
      return places;
    }),

  /** Driving route via OSRM demo server; polyline + maneuver steps. */
  route: publicQuery
    .input(
      z.object({
        fromLat: z.number().min(-90).max(90),
        fromLon: z.number().min(-180).max(180),
        toLat: z.number().min(-90).max(90),
        toLon: z.number().min(-180).max(180),
      }),
    )
    .query(async ({ input }) => {
      const coords = `${input.fromLon},${input.fromLat};${input.toLon},${input.toLat}`;
      const key = cacheKey("route", coords);
      const hit = routeCache.get(key);
      if (hit) return hit;
      const url = `${OSRM}/${coords}?overview=full&geometries=geojson&steps=true`;
      const data = (await fetchJson(url)) as {
        code?: string;
        routes?: Array<{
          distance: number;
          duration: number;
          geometry: { coordinates: [number, number][] };
          legs: Array<{
            steps: Array<{
              name?: string;
              ref?: string;
              distance: number;
              maneuver: {
                type: string;
                modifier?: string;
                location: [number, number];
                exit?: number;
              };
            }>;
          }>;
        }>;
      };
      const r = data.routes?.[0];
      if (data.code !== "Ok" || !r) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No se encontró una ruta en coche entre esos puntos",
        });
      }
      const steps: RouteStep[] = r.legs.flatMap((leg) =>
        leg.steps.map((s) => ({
          type: s.maneuver.type,
          modifier: s.maneuver.modifier ?? "straight",
          name: s.name || s.ref || "",
          distanceM: Math.round(s.distance),
          lon: s.maneuver.location[0],
          lat: s.maneuver.location[1],
          exit: s.maneuver.exit,
        })),
      );
      const route: RouteData = {
        distanceM: Math.round(r.distance),
        durationS: Math.round(r.duration),
        points: r.geometry.coordinates,
        steps,
      };
      if (routeCache.size >= ROUTE_CACHE_MAX) {
        const firstKey = routeCache.keys().next().value;
        if (firstKey !== undefined) routeCache.delete(firstKey);
      }
      routeCache.set(key, route);
      return route;
    }),
});
