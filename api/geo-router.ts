import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import type { GeoPlace, RouteData, RouteStep } from "@contracts/geo";

const UA = "tesla-autopilot-sim/1.0 (TypeSafe Jev driving demo)";
const PHOTON = "https://photon.komoot.io/api/";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const VALHALLA = "https://valhalla1.openstreetmap.de/route";

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

  /** Driving route: OSRM demo first, Valhalla (FOSSGIS) as fallback when the
   *  OSRM path from the container is having a bad window. Cached in memory. */
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
      let route: RouteData;
      try {
        route = await osrmRoute(coords);
      } catch (err) {
        // "no route between those points" is definitive — don't fallback
        if (err instanceof TRPCError && err.code === "NOT_FOUND") throw err;
        route = await valhallaRoute(input);
      }
      if (routeCache.size >= ROUTE_CACHE_MAX) {
        const firstKey = routeCache.keys().next().value;
        if (firstKey !== undefined) routeCache.delete(firstKey);
      }
      routeCache.set(key, route);
      return route;
    }),
});

interface OsrmStep {
  name?: string;
  ref?: string;
  distance: number;
  maneuver: { type: string; modifier?: string; location: [number, number]; exit?: number };
}

async function osrmRoute(coords: string): Promise<RouteData> {
  const url = `${OSRM}/${coords}?overview=full&geometries=geojson&steps=true`;
  const data = (await fetchJson(url)) as {
    code?: string;
    routes?: Array<{
      distance: number;
      duration: number;
      geometry: { coordinates: [number, number][] };
      legs: Array<{ steps: OsrmStep[] }>;
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
  return {
    distanceM: Math.round(r.distance),
    durationS: Math.round(r.duration),
    points: r.geometry.coordinates,
    steps,
  };
}

/* ── Valhalla fallback ────────────────────────────────────── */

/** Google-encoded polyline with 1e6 precision (Valhalla's default shape). */
export function decodePolyline6(str: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 1e6;
  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < str.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < str.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

interface ValhallaManeuver {
  type: number;
  instruction: string;
  street_names?: string[];
  length: number; // km
  begin_shape_index: number;
  roundabout_exit_count?: number;
}

/** Valhalla numeric maneuver type → OSRM-style type/modifier. Verified
 *  empirically against the demo server (instructions inspected in es-ES). */
function valhallaType(t: number): [string, string] {
  switch (t) {
    case 1: return ["depart", "straight"];
    case 2: return ["depart", "right"];
    case 3: return ["depart", "left"];
    case 4: return ["arrive", "straight"];
    case 5: return ["arrive", "right"];
    case 6: return ["arrive", "left"];
    case 7: return ["new name", "straight"];
    case 8: return ["continue", "straight"];
    case 9: return ["fork", "right"];
    case 10: return ["turn", "right"];
    case 11: return ["turn", "sharp right"];
    case 12: return ["turn", "uturn"];
    case 13: return ["turn", "sharp left"];
    case 14: return ["turn", "uturn"];
    case 15: return ["turn", "left"];
    case 16: return ["fork", "left"];
    case 17: return ["turn", "slight left"];
    case 18: return ["turn", "slight right"];
    case 19: return ["off ramp", "left"];
    case 20: return ["off ramp", "straight"];
    case 21: return ["off ramp", "left"];
    case 22: return ["continue", "straight"];
    case 23: return ["fork", "right"];
    case 24: return ["fork", "left"];
    case 25: return ["merge", "straight"];
    case 26: return ["roundabout", "straight"];
    case 27: return ["exit roundabout", "straight"];
    default: return ["continue", "straight"];
  }
}

export async function valhallaRoute(input: {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
}): Promise<RouteData> {
  const payload = JSON.stringify({
    locations: [
      { lat: input.fromLat, lon: input.fromLon },
      { lat: input.toLat, lon: input.toLon },
    ],
    costing: "auto",
    directions_options: { units: "kilometers", language: "es-ES" },
  });
  // reuse the retrying fetch: wrap POST as a url-less call via fetch directly
  let lastErr: unknown = null;
  let data: {
    trip?: {
      summary?: { length?: number; time?: number };
      legs?: Array<{ shape?: string; maneuvers?: ValhallaManeuver[] }>;
      status_message?: string;
    };
  } | null = null;
  for (let attempt = 0; attempt < 4 && !data; attempt++) {
    try {
      const res = await fetch(VALHALLA, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA },
        body: payload,
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Valhalla devolvió ${res.status}`,
        });
      }
      data = (await res.json()) as typeof data;
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      lastErr = err;
      if (attempt < 3) await sleep(400 * (attempt + 1));
    }
  }
  if (!data?.trip?.legs?.length) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Fallo de red con los servicios de ruta (OSRM y Valhalla): ${
        lastErr instanceof Error ? lastErr.message : "sin respuesta"
      }`,
    });
  }
  const trip = data.trip;
  const points: [number, number][] = [];
  const steps: RouteStep[] = [];
  for (const leg of trip.legs) {
    const shape = decodePolyline6(leg.shape ?? "");
    for (const [lon, lat] of shape) points.push([lon, lat]);
    for (const m of leg.maneuvers ?? []) {
      const [type, modifier] = valhallaType(m.type);
      const pt = shape[m.begin_shape_index] ?? shape[0] ?? [0, 0];
      steps.push({
        type,
        modifier,
        name: (m.street_names ?? []).join(" / "),
        distanceM: Math.round((m.length ?? 0) * 1000),
        lon: pt[0],
        lat: pt[1],
        exit: m.type === 26 ? m.roundabout_exit_count : undefined,
      });
    }
  }
  if (points.length < 2 || steps.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No se encontró una ruta en coche entre esos puntos",
    });
  }
  return {
    distanceM: Math.round((trip.summary?.length ?? 0) * 1000),
    durationS: Math.round(trip.summary?.time ?? 0),
    points,
    steps,
  };
}
