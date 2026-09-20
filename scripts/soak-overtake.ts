/** Soak: 300 sim-seconds of natural traffic with the worst-case always-
 *  accelerate stub, logging every overtake (speed, lateral separation,
 *  oncoming nearby) and any crash/incident. Pass criteria: no crash,
 *  every pass at ≤ 21 km/h, lateral separation ≥ 1.8 m while alongside. */
import { AutopilotGame } from "../src/game/engine";
import type { DecideResponse, PerceptionState } from "../contracts/ai";
import type { RouteData } from "../contracts/geo";

const ROUTE_URL =
  "http://localhost:3000/api/trpc/geo.route?input=" +
  encodeURIComponent(
    '{"json":{"fromLat":40.416863,"fromLon":-3.7038762,"toLat":40.4721,"toLon":-3.6823}}',
  );

const accelerateAlways = (_s: PerceptionState): Promise<DecideResponse> =>
  Promise.resolve({
    model: "stub",
    answers: {
      speed_action: { type: "choice", choice: "accelerate", confidence: 1, probabilities: { accelerate: 1, maintain: 0, brake: 0 } },
      cruise: { type: "choice", choice: "off", confidence: 1, probabilities: { cruise_80: 0, cruise_100: 0, cruise_120: 0, off: 1 } },
      maneuver_ok: { type: "noul", noul: 0.95, confidence: 1 },
      immediate_danger: { type: "noul", noul: 0.02, confidence: 1 },
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  });

async function main() {
  const res = await fetch(ROUTE_URL);
  const j = await res.json();
  const route = (j as { result: { data: { json: RouteData } } }).result.data.json;
  let ended: { crashed?: boolean; reason?: string } | null = null;
  const engine = new AutopilotGame(
    route,
    {
      onFrame: () => {},
      onDecision: () => {},
      onLog: () => {},
      onError: () => {},
      onTripEnd: (r) => { ended = r; },
      requestDecision: accelerateAlways,
    },
    { decisionEveryMs: 900 },
  );
  const e = engine as any;
  const passes: Array<{ t: number; v: number; lat: number; oncoming: boolean }> = [];
  let cur: { v: number; lat: number; oncoming: boolean } | null = null;
  const stopWindows: Array<[number, number]> = [[40, 95], [150, 210], [250, 300]];
  let van: any = null; // dedicated delivery van injected during windows
  for (let i = 0; i < 6000 && !ended; i++) { // 300 sim-s
    // orchestrate a delivery van parked in lane during windows
    const w = stopWindows.find(([a, b]) => e.simTime >= a && e.simTime < b);
    if (w) {
      if (!van) {
        van = {
          id: 7777, s: e.s + 90, dir: 1, speedMs: 0, baseSpeedMs: 0,
          kind: "truck", color: "#c2a25c", changing: false, latOff: 0,
        };
      } else {
        // re-parking the SAME van for a later window: place it 90 m ahead
        // again — a truck materialising 5 m in front is a script artifact,
        // not a scenario the engine should ever face
        van.s = e.s + 90;
        van.latOff = 0;
      }
      van.speedMs = 0; van.baseSpeedMs = 0;
      if (!e.traffic.includes(van)) e.traffic.push(van);
    } else if (van) {
      van.baseSpeedMs = 45 / 3.6; // van drives off at window end
      if (van.s - e.s > 1400) van = null; // recycled by distance filter
    }
    engine.update(0.05);
    if (i % 100 === 0) { // every 5 sim-s
      const lead = e.traffic.filter((t: any) => t.dir === 1).sort((a: any, b: any) => a.s - b.s)[0];
      console.log(`t=${e.simTime.toFixed(0)}s v=${e.speedKmh.toFixed(0)} gap=${lead ? (lead.s - e.s).toFixed(1) : "-"} leadV=${lead ? (lead.speedMs * 3.6).toFixed(0) : "-"} wait=${e.blockedWaitS?.toFixed(1)} ot=${e.overtakeId} van=${van ? "SÍ" : "no"}`);
    }
    if (e.overtakeId !== null) {
      const t = e.traffic.find((x: any) => x.id === e.overtakeId);
      if (t) {
        const lat = (t.latOff ?? 0) + 1.9 - e.teslaLat;
        const oncoming = e.traffic.some((o: any) => o.dir === -1 && o.s - e.s > -25 && o.s - e.s < 160);
        if (!cur) cur = { v: 0, lat: Infinity, oncoming };
        cur.v = Math.max(cur.v, e.speedKmh);
        if (Math.abs(t.s - e.s) < 3) cur.lat = Math.min(cur.lat, lat);
        cur.oncoming = cur.oncoming || oncoming;
      }
    } else if (cur) {
      passes.push({ t: e.simTime, v: cur.v, lat: cur.lat === Infinity ? 99 : cur.lat, oncoming: cur.oncoming });
      cur = null;
    }
  }
  console.log(`viaje: ${ended ? `${ended.crashed ? "CRASH" : "fin"} (${ended.reason})` : "siguió"} a los ${e.simTime?.toFixed(0)}s | incidentes=${e.incidents}`);
  console.log(`causas: ${JSON.stringify(e.incidentCauses)}`);
  console.log(`adelantamientos: ${passes.length}`);
  for (const p of passes) {
    console.log(`  t=${p.t.toFixed(0)}s v_max=${p.v.toFixed(1)} km/h sep=${p.lat.toFixed(2)} m contrario_cerca=${p.oncoming}`);
  }
  const bad = passes.filter((p) => p.v > 21 || p.lat < 1.8);
  console.log(bad.length === 0 && !(ended && ended.crashed)
    ? "OK: adelantamientos lentos, separados y sin crash"
    : "FALLO");
  process.exit(bad.length === 0 && !(ended && ended.crashed) ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
