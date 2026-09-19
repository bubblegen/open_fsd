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

async function scenario(
  name: string,
  startSpeedKmh: number,
  stoppedAtM: number,
  opts: { victimKmh?: number; oncomingAtM?: number } = {},
): Promise<Ctx & { midPassLat: number; signals: Set<string>; overtakeTried: boolean }> {
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
  const victimKmh = opts.victimKmh ?? 0;
  const car = {
    id: 9999, s: e.s + stoppedAtM, dir: 1, speedMs: victimKmh / 3.6, baseSpeedMs: victimKmh / 3.6,
    kind: "car", color: "#ffffff", changing: false, latOff: 0,
  };
  const oncoming = opts.oncomingAtM !== undefined ? {
    id: 8888, s: e.s + opts.oncomingAtM, dir: -1, speedMs: 50 / 3.6, baseSpeedMs: 50 / 3.6,
    kind: "car", color: "#000000", changing: false, latOff: 0,
  } : null;
  const ctx: Ctx = { engine, car, minDs: Infinity, maxPassSpeed: 0, passed: false, waitedS: 0 };
  let prevWait = 0;
  let midPassLat = 0; // lateral separation recorded when longitudinally alongside
  const signals = new Set<string>(); // indicator states observed during the flow
  for (let i = 0; i < 3600; i++) { // 180 sim-seconds max
    if (oncoming) oncoming.s = e.s + (opts.oncomingAtM ?? 100); // continuous stream pinned
    e.traffic = oncoming ? [car, oncoming] : [car];
    e.crossings = []; // no random pedestrians: deterministic vehicle-only test
    car.speedMs = victimKmh / 3.6; car.baseSpeedMs = victimKmh / 3.6; // pin victim's speed
    engine.update(0.05);
    if (e.overtakeSignal) signals.add(e.overtakeSignal);
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
    `sep.lateral paso=${midPassLat.toFixed(2)}m | intermitentes=[${[...signals].join(",")}] | crash=${e.crashed}${e.crashed ? ` (${e.crashReason})` : ""}`);
  return { ...ctx, midPassLat, signals, overtakeTried: e.overtakeId !== null || signals.has("passing") } as Ctx & { midPassLat: number; signals: Set<string>; overtakeTried: boolean };
}

async function main() {
  const a = await scenario("A) 50 km/h → coche parado a 120m", 50, 120);
  const b = await scenario("B) 8 km/h → coche parado a 15m (ex-fantasma)", 8, 15);
  const c = await scenario("C) 120 km/h → coche parado a 260m", 120, 260);
  const d = await scenario("D) 60 km/h → coche a 10 km/h a 100m (lento)", 60, 100, { victimKmh: 10 });
  const x = await scenario("X) 40 km/h → parado a 60m CON contrario a 100m", 40, 60, { oncomingAtM: 100 });
  const lat = (c: Ctx & { midPassLat: number }) => c.midPassLat;
  const ok =
    !a.engine.crashed && !b.engine.crashed && !c.engine.crashed && !d.engine.crashed && !x.engine.crashed &&
    a.minDs >= 6.0 && b.minDs >= 6.0 && c.minDs >= 6.0 && d.minDs >= 6.0 && // AEB holds a real buffer now
    a.passed && b.passed && d.passed && // stopped/crawling eventually passed
    a.maxPassSpeed <= 12 && b.maxPassSpeed <= 12 && // walking pace past a stopped car
    d.maxPassSpeed <= 21 && // brisk-but-safe past a 10 km/h crawler
    lat(a) >= 1.8 && lat(b) >= 1.8 && lat(d) >= 1.8 && // real lateral separation while alongside
    !x.passed && !x.overtakeTried && // oncoming lane occupied → we wait, never pull out
    a.signals.has("passing") && a.signals.has("returning") && // L to pass, R to rejoin
    b.signals.has("passing") && b.signals.has("returning") &&
    d.signals.has("passing") && d.signals.has("returning");
  console.log(ok ? "OK: cuerpos sólidos con margen, espera + adelantamiento lento y seguro, sin salir con contrario" : "FALLO");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
