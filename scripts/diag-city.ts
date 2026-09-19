/**
 * Urban braking diagnosis: Madrid Sol → Chamartín with a Jev-like prudent
 * policy, logging every brake decision and its cause.
 */
import { AutopilotGame } from "../src/game/engine";
import type { DecideResponse, PerceptionState } from "../contracts/ai";
import type { RouteData } from "../contracts/geo";

const ROUTE_URL =
  "http://localhost:3000/api/trpc/geo.route?input=" +
  encodeURIComponent(
    '{"json":{"fromLat":40.416863,"fromLon":-3.7038762,"toLat":40.4721,"toLon":-3.6823}}',
  );

const brakes: string[] = [];
let brakeCount = 0;
let accelCount = 0;
let stopTime = 0;
let fullStops = 0;
let wasMoving = true;

function stubJev(state: PerceptionState): DecideResponse {
  const ped = state.traffic.pedestrian;
  const limit = state.gps.speedLimitKmh;
  const speed = state.gps.speedKmh;
  const manDist = state.gps.distanceToManeuverM;
  const danger = ped && ped.distanceM < 10 && (!ped.lateralM || Math.abs(ped.lateralM) < 1.5) ? 0.95 : 0.05;
  // Jev-like: brake only when the ped will still be in our corridor on arrival
  // PANICKY Jev: brakes for ANY reported pedestrian within 40 m
  let brake = danger >= 0.55 || (ped !== null && ped.distanceM < 40);
  const speedChoice = brake ? "brake" : speed < limit - 3 ? "accelerate" : "maintain";
  if (brake) {
    brakeCount++;
    if (brakes.length < 60) brakes.push(`t=${state.gps.elapsedS?.toFixed(0) ?? "?"} v=${speed} lim=${limit} ped=${ped ? ped.distanceM + "m" : "-"} lane="${state.traffic.laneAhead}" man=${Math.round(manDist)}m`);
  } else if (speedChoice === "accelerate") accelCount++;
  const manSafe = manDist < 15 && speed > 40 ? 0.3 : 0.9;
  return {
    model: "stub-jev",
    answers: {
      speed_action: { type: "choice", choice: speedChoice, confidence: 0.9, probabilities: { accelerate: 0.8, maintain: 0.1, brake: 0.1 } },
      cruise: { type: "choice", choice: "off", confidence: 0.9, probabilities: { cruise_80: 0, cruise_100: 0, cruise_120: 0, off: 1 } },
      maneuver_ok: { type: "noul", noul: manSafe, confidence: 0.9 },
      immediate_danger: { type: "noul", noul: danger, confidence: 0.9 },
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function main() {
  const res = await fetch(ROUTE_URL);
  const route = ((await res.json()) as { result: { data: { json: RouteData } } }).result.data.json;
  let ended: { arrived: boolean; crashed: boolean; reason?: string } | null = null;
  const engine = new AutopilotGame(route, {
    onFrame: () => {},
    onDecision: () => {},
    onLog: () => {},
    onError: () => {},
    onTripEnd: (r) => { ended = r; },
    requestDecision: async (s) => stubJev(s),
  }, { decisionEveryMs: 0 });
  const dt = 1 / 30;
  let simT = 0;
  while (!ended && simT < 30 * 60) {
    engine.update(dt);
    simT += dt;
    const spd = (engine as unknown as { speedKmh: number }).speedKmh;
    if (spd < 1) { stopTime += dt; if (wasMoving) { fullStops++; wasMoving = false; } }
    else if (spd > 8) wasMoving = true;
    if (Math.floor(simT * 30) % 15 === 0) await new Promise((r) => setImmediate(r));
  }
  console.log(`simTime ${Math.floor(simT / 60)}:${String(Math.floor(simT % 60)).padStart(2, "0")} | brakes=${brakeCount} accels=${accelCount} fullStops=${fullStops} stopped=${stopTime.toFixed(0)}s`);
  console.log("── first brake causes ──");
  brakes.forEach((b) => console.log(" ", b));
  console.log("result:", ended);
}
main().catch((e) => { console.error(e); process.exit(1); });
