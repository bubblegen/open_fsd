/**
 * Fast-forward engine test: runs the real AutopilotGame over the real
 * Sol → Chamartín route with a stubbed Jev policy, in Node, at full speed.
 * Validates physics, spawning, maneuvers, arrival and crash logic.
 */
import { AutopilotGame } from "../src/game/engine";
import type { DecideResponse, PerceptionState } from "../contracts/ai";
import type { RouteData } from "../contracts/geo";

const ROUTE_URL =
  "http://localhost:3000/api/trpc/geo.route?input=" +
  encodeURIComponent(
    '{"json":{"fromLat":40.416863,"fromLon":-3.7038762,"toLat":40.4721,"toLon":-3.6823}}',
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
  console.log(`route: ${(route.distanceM / 1000).toFixed(1)} km, ${route.points.length} pts, ${route.steps.length} steps`);

  let lastPrint = 0;
  let ended: { arrived: boolean; crashed: boolean; reason?: string } | null = null;
  const ring: string[] = [];

  const engine = new AutopilotGame(route, {
    onFrame: () => {
      const rs = engine.renderState();
      const v = rs.vehicleAhead;
      ring.push(
        `t=${rs.elapsed.toFixed(1)} v=${Math.round(rs.speedKmh)} lim=${rs.limit} gap=${v ? v.distanceM : "-"} lv=${v ? v.speedKmh : "-"} acc=${(engine as unknown as { accelCmd: string }).accelCmd}`,
      );
      if (ring.length > 12) ring.shift();
    },
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
  const MAX_S = 30 * 60; // 30 sim-minutes
  while (!ended && simT < MAX_S) {
    engine.update(dt);
    simT += dt;
    if (Math.floor(simT) % 60 === 0 && simT - lastPrint >= 1) {
      lastPrint = simT;
      const rs = engine.renderState();
      console.log(
        `t=${String(Math.floor(simT / 60)).padStart(2, "0")}:${String(Math.floor(simT % 60)).padStart(2, "0")} ` +
          `s=${Math.round(rs.s)}m v=${Math.round(rs.speedKmh)}km/h lim=${rs.limit} ` +
          `dec=${(engine as unknown as { decisions: number }).decisions} ` +
          `inc=${(engine as unknown as { incidents: number }).incidents} ` +
          `traffic=${rs.traffic.length} peds=${rs.crossings.length} ` +
          `man=${rs.nextManeuver ? Math.round(rs.nextManeuver.distanceM) + "m" : "-"}`,
      );
    }
    if (Math.floor(simT * 30) % 15 === 0) await new Promise((r) => setImmediate(r));
  }

  const rs = engine.renderState();
  console.log("── END ──");
  console.log("simTime:", simT.toFixed(1), "s | distance:", Math.round(rs.s), "m");
  console.log("result:", ended ?? "TIMEOUT (did not finish in 30 min)");
  if (ended && ended.crashed) console.log("context:\n" + ring.join("\n"));
  if (!ended && rs.speedKmh === 0 && rs.traffic.length === 0) console.log("stalled with empty road!");
  process.exit(ended ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
