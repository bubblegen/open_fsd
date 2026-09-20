/** One-off: trace scenario D approach — why do we arrive at ds≈0.8m? */
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
  const engine = new AutopilotGame(
    route,
    { onFrame: () => {}, onDecision: () => {}, onLog: () => {}, onError: () => {}, onTripEnd: () => {}, requestDecision: accelerateAlways },
    { decisionEveryMs: 900 },
  );
  const e = engine as any;
  e.speedKmh = 60;
  const car = { id: 8888, s: e.s + 100, dir: 1, speedMs: 10 / 3.6, baseSpeedMs: 10 / 3.6, kind: "car", color: "#000", changing: false, latOff: 0 };
  let minDs = Infinity;
  let prevOt: number | null = null;
  for (let i = 0; i < 3600; i++) {
    e.traffic = [car];
    e.crossings = [];
    car.speedMs = 10 / 3.6; car.baseSpeedMs = 10 / 3.6;
    engine.update(0.05);
    const ds = car.s - e.s;
    if (e.overtakeId === null && ds > -1 && ds < minDs) minDs = ds;
    if (e.overtakeId !== prevOt) {
      console.log(`>>> i=${i} ot ${prevOt} -> ${e.overtakeId} ds=${ds.toFixed(2)} v=${e.speedKmh.toFixed(1)} lat=${e.teslaLat.toFixed(2)} carLatOff=${(car.latOff ?? 0).toFixed(2)} hold=${e.holdYieldId} wait=${e.blockedWaitS?.toFixed(2)} em=${e.emergency} tag=${e.brakeTag}`);
      prevOt = e.overtakeId;
    }
    if (i % 100 === 0) console.log(`i=${i} ds=${ds.toFixed(1)} v=${e.speedKmh.toFixed(1)} ot=${e.overtakeId} wait=${e.blockedWaitS?.toFixed(1)} minDs=${minDs.toFixed(2)}`);
    if (ds < -7) { console.log("PASSED"); break; }
    if (e.crashed) { console.log("CRASH", e.crashReason); break; }
  }
  console.log(`minDs(approach)=${minDs.toFixed(2)} bumper=${(minDs - 4.6).toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
