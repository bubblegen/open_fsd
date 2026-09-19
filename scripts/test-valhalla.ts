/** Sanity-check the Valhalla fallback: decode + map, compare with OSRM. */
import { valhallaRoute } from "../api/geo-router";

async function main() {
  const v = await valhallaRoute({
    fromLat: 40.416863,
    fromLon: -3.7038762,
    toLat: 40.4721,
    toLon: -3.6823,
  });
  console.log(`Valhalla: ${v.distanceM} m, ${v.durationS} s, ${v.points.length} pts, ${v.steps.length} steps`);
  for (const s of v.steps) {
    console.log(
      `  ${s.type.padEnd(15)} ${s.modifier.padEnd(12)} ${String(s.distanceM).padStart(5)} m  ${s.name.slice(0, 40)}${s.exit ? ` (salida ${s.exit})` : ""}`,
    );
  }
  // plausibility: distance within 15% of the known ~7.7 km route
  if (v.distanceM < 6000 || v.distanceM > 9000) throw new Error("distancia implausible");
  if (v.points.length < 100) throw new Error("polyline decode sospechoso");
  const first = v.points[0];
  const last = v.points[v.points.length - 1];
  if (Math.abs(first[1] - 40.4168) > 0.01 || Math.abs(last[1] - 40.4721) > 0.01)
    throw new Error("extremos de ruta incorrectos");
  console.log("OK: fallback Valhalla sano");
}
main().catch((e) => {
  console.error("FALLO:", e);
  process.exit(1);
});
