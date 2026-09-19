import type { Context } from "hono";

/**
 * Server-side proxy + cache for raster map tiles (Esri World Street Map
 * over commercial + OSM sources). Proxied so the game canvas never hits
 * CORS limits and repeated tiles are served from memory. The renderer
 * applies a dark-theme CSS filter on the client.
 */

const UPSTREAM =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile";
const UA = "tesla-autopilot-sim/1.0 (TypeSafe Jev driving demo)";
const MAX_CACHE = 900;

const cache = new Map<string, Buffer>();

export async function tilesHandler(c: Context) {
  const z = Number(c.req.param("z"));
  const x = Number(c.req.param("x"));
  const y = Number(c.req.param("y"));
  if (
    !Number.isInteger(z) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    z < 10 ||
    z > 19 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z
  ) {
    return c.body(null, 400);
  }
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    // refresh recency
    cache.delete(key);
    cache.set(key, hit);
    return c.body(new Uint8Array(hit), 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    });
  }
  try {
    const res = await fetch(`${UPSTREAM}/${z}/${y}/${x}`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return c.body(null, 502);
    const buf = Buffer.from(await res.arrayBuffer());
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, buf);
    return c.body(new Uint8Array(buf), 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    });
  } catch {
    return c.body(null, 502);
  }
}
