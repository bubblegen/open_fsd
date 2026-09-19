/**
 * Targeted regression: the Tesla must NEVER pass through a vehicle.
 *  A) approach a STOPPED car at 50 km/h with Jev flooring "accelerate"
 *     → must stop with bumper margin, wait, then creep past at ≤6 km/h
 *  B) approach at 8 km/h (the old ghost-through speed) → same guarantees
 */
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

interface Ctx { engine: AutopilotGame; car: any; minDs: number; maxPassSpeed: number; passed: boolean; waitedS: number }

async function scenario(name: string, startSpeedKmh: number, stoppedAtM: number): Promise<Ctx> {
  const res = await fetch(ROUTE_URL);
  const j = await res.json();
  const route = (j as { result: { data: { json: RouteData } } }).result.data.json;
  const engine = new AutopilotGame(
    route,
    {
      onFrame: () => {},
      onDecision: () => {},
      onLog: () => {},
      onError: (m) => console.log(`  [engine error] ${m}`),
      onTripEnd: () => {},
      requestDecision: accelerateAlways,
    },
    { decisionEveryMs: 900 },
  );
  const e = engine as any;
  e.speedKmh = startSpeedKmh;
  const car = {
    id: 9999, s: e.s + stoppedAtM, dir: 1, speedMs: 0, baseSpeedMs: 0,
    kind: "car", color: "#ffffff", changing: false, latOff: 0,
  };
  const ctx: Ctx = { engine, car, minDs: Infinity, maxPassSpeed: 0, passed: false, waitedS: 0 };
  let prevWait = 0;
  let midPassLat = 0; // lateral separation recorded when longitudinally alongside
  for (let i = 0; i < 3600; i++) { // 180 sim-seconds max
    e.traffic = [car]; // only our victim; spawnTraffic re-adds nothing
    car.speedMs = 0; car.baseSpeedMs = 0; // stays stopped
    engine.update(0.05);
    const ds = car.s - e.s;
    if (e.overtakeId === null && ds > -1 && ds < ctx.minDs) ctx.minDs = ds; // approach phase only
    if (e.overtakeId !== null) {
      if (e.speedKmh > ctx.maxPassSpeed) ctx.maxPassSpeed = e.speedKmh;
      if (ds < 1 && midPassLat === 0) midPassLat = (car.latOff ?? 0) + 1.9 - e.teslaLat;
    }
    if (e.blockedWaitS > prevWait) ctx.waitedS += 0.05;
    prevWait = e.blockedWaitS;
    if (ds < -7) { ctx.passed = true; break; } // fully past it
    if (e.crashed) break;
  }
  const bumper = ctx.minDs - 4.6;
  console.log(`${name}: min ds(aprox)=${ctx.minDs.toFixed(2)}m (parachoques ${bumper.toFixed(2)}m) | ` +
    `espera=${ctx.waitedS.toFixed(1)}s | adelantó=${ctx.passed} | v_max_paso=${ctx.maxPassSpeed.toFixed(1)} km/h | ` +
    `sep.lateral paso=${midPassLat.toFixed(2)}m | crash=${e.crashed}${e.crashed ? ` (${e.crashReason})` : ""}`);
  return { ...ctx, midPassLat } as Ctx & { midPassLat: number };
}

async function main() {
  const a = await scenario("A) 50 km/h → coche parado a 120m", 50, 120);
  const b = await scenario("B) 8 km/h → coche parado a 15m (ex-fantasma)", 8, 15);
  const c = await scenario("C) 120 km/h → coche parado a 260m", 120, 260);
  const lat = (c: Ctx & { midPassLat: number }) => c.midPassLat;
  const ok =
    !a.engine.crashed && !b.engine.crashed && !c.engine.crashed &&
    a.minDs >= 4.4 && b.minDs >= 4.4 && // never touched on approach, let alone through
    a.passed && b.passed && // eventually crept past
    a.maxPassSpeed <= 6.6 && b.maxPassSpeed <= 6.6 &&
    lat(a) >= 1.8 && lat(b) >= 1.8 && // real lateral separation while alongside
    c.minDs >= 4.4; // motorway-speed stop also keeps bumper margin
  console.log(ok ? "OK: cuerpos sólidos, espera + adelantamiento lento" : "FALLO");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
