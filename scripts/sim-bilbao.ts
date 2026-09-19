/**
 * Full-route benchmark: Bilbao → Laredo (55 km, A-8) with the real engine
 * and a stubbed prudent-Jev policy, fast-forwarded in Node. Produces the
 * simulated trip time to compare against Google Maps (~42 min) plus a
 * speed histogram to see where time is lost.
 */
import { AutopilotGame } from "../src/game/engine";
import type { DecideResponse, PerceptionState } from "../contracts/ai";
import type { RouteData } from "../contracts/geo";

const ROUTE_URL =
  "http://localhost:3000/api/trpc/geo.route?input=" +
  encodeURIComponent(
    '{"json":{"fromLat":43.2630,"fromLon":-2.9350,"toLat":43.4103,"toLon":-3.4150}}',
  );

function stubJev(state: PerceptionState): DecideResponse {
  const ped = state.traffic.pedestrian;
  const limit = state.gps.speedLimitKmh;
  const speed = state.gps.speedKmh;
  const manDist = state.gps.distanceToManeuverM;
  const danger = ped && ped.distanceM < 10 ? 0.95 : 0.05;
  const brake = danger >= 0.55 || (ped !== null && ped.distanceM < 32);
  const speedChoice = brake ? "brake" : speed < limit - 3 ? "accelerate" : "maintain";
  const manSafe = manDist < 15 && speed > 40 ? 0.3 : 0.9;
  return {
    model: "stub-jev",
    answers: {
      speed_action: {
        type: "choice",
        choice: speedChoice,
        confidence: 0.9,
        probabilities: { accelerate: 0.8, maintain: 0.1, brake: 0.1 },
      },
      cruise: {
        type: "choice",
        choice: limit >= 90 ? "cruise_120" : "off",
        confidence: 0.9,
        probabilities: { cruise_80: 0, cruise_100: 0, cruise_120: 1, off: 0 },
      },
      maneuver_ok: { type: "noul", noul: manSafe, confidence: 0.9 },
      immediate_danger: { type: "noul", noul: danger, confidence: 0.9 },
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function main() {
  const res = await fetch(ROUTE_URL);
  const json = (await res.json()) as { result: { data: { json: RouteData } } };
  const route = json.result.data.json;
  console.log(`route: ${(route.distanceM / 1000).toFixed(1)} km, ${route.steps.length} steps`);

  let ended: { arrived: boolean; crashed: boolean; reason?: string } | null = null;
  const buckets = { stopped: 0, slow: 0, mid: 0, fast: 0 }; // <8 | 8-50 | 50-90 | >=90 km/h
  let lowSpeedTime = 0;
  let lastPrint = -1;

  const engine = new AutopilotGame(route, {
    onFrame: () => {},
    onDecision: () => {},
    onLog: () => {},
    onError: (m) => console.log("  [api-error]", m),
    onTripEnd: (r) => {
      ended = r;
    },
    requestDecision: async (state) => stubJev(state),
  }, { decisionEveryMs: 0 });

  const dt = 1 / 30;
  let simT = 0;
  const MAX_S = 90 * 60;
  while (!ended && simT < MAX_S) {
    engine.update(dt);
    simT += dt;
    const v = (engine as unknown as { speedKmh: number }).speedKmh;
    if (v < 8) buckets.stopped += dt;
    else if (v < 50) buckets.slow += dt;
    else if (v < 90) buckets.mid += dt;
    else buckets.fast += dt;
    const man = (engine as unknown as { nextManeuver: () => { distanceM: number } | null }).nextManeuver();
    if (v < 8) lowSpeedTime += dt;
    const min = Math.floor(simT / 60);
    if (min !== lastPrint && simT % 60 < dt) {
      lastPrint = min;
      const rs = engine.renderState();
      const veh = rs.vehicleAhead;
      const acc = (engine as unknown as { accelCmd: string }).accelCmd;
      console.log(
        `t=${String(min).padStart(2, "0")}min s=${(rs.s / 1000).toFixed(1)}km v=${Math.round(rs.speedKmh)}km/h ` +
          `lim=${rs.limit} acc=${acc} ` +
          (veh ? `leader=${veh.type}@${veh.distanceM}m doing ${veh.speedKmh}km/h` : "leader=none") +
          ` traffic=${rs.traffic.length}` +
          (man ? ` man=${Math.round(man.distanceM)}m(${man.type})` : ""),
      );
    }
    if (Math.floor(simT * 30) % 15 === 0) await new Promise((r) => setImmediate(r));
  }

  const eng = engine as unknown as {
    decisions: number; incidents: number; maneuversDone: number;
    distanceM: number; cruiseActive: boolean;
  };
  console.log("── END ──");
  console.log(`simTime: ${Math.floor(simT / 60)}:${String(Math.floor(simT % 60)).padStart(2, "0")} | distance: ${(eng.distanceM / 1000).toFixed(1)} km`);
  console.log(`avg speed: ${((eng.distanceM / 1000) / (simT / 3600)).toFixed(1)} km/h`);
  console.log(`decisions: ${eng.decisions} | incidents: ${eng.incidents} | maneuvers: ${eng.maneuversDone}`);
  console.log(`time <8km/h: ${buckets.stopped.toFixed(0)}s | 8-50: ${buckets.slow.toFixed(0)}s | 50-90: ${buckets.mid.toFixed(0)}s | >=90: ${buckets.fast.toFixed(0)}s`);
  console.log("result:", ended ?? "TIMEOUT");
  process.exit(ended && ended.arrived ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
