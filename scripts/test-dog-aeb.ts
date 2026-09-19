/** Regression: a fast dog near the lane edge with the car at 36 km/h used to
 *  be invisible to the AEB (clearsInS ≈ 0 outside the 2.3 m corridor → no
 *  braking until ~0.2 s from impact → "Atropello a un perro"). The AEB must
 *  now brake so the car never enters the crash zone (ds<2.2 & |lat|<1.4) with
 *  speed > 3 km/h, from any approach distance. */
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

  let failures = 0;
  // scenario matrix: dog lateral position × dog lateral speed × car speed × distance
  const latStarts = [-2.6, -2.2, -1.8, -1.2]; // relative to lane centre (negative = approaching from left)
  const dogSpeeds = [2.6, 3.2, 3.6]; // m/s lateral
  const carSpeeds = [30, 36, 50]; // km/h
  const dists = [12, 20, 30];

  for (const lat0 of latStarts) {
    for (const dogV of dogSpeeds) {
      for (const carKmh of carSpeeds) {
        for (const dist of dists) {
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
          // pin the dog: crossing toward our lane, car approaching fast
          e.crossings = [{
            id: 9999, s: e.s + dist, lateral: 1.9 + lat0,
            from: -(Math.abs(lat0) + 4), to: Math.abs(lat0) + 4,
            speed: dogV, kind: "perro", done: false,
          }];
          e.traffic = [];
          e.speedKmh = carKmh;
          let minDs = Infinity, minDsSpeed = 0, minLatAtMinDs = 99;
          for (let i = 0; i < 600 && !ended; i++) { // 30 sim-s
            engine.update(0.05);
            const c = e.crossings[0];
            if (c && !c.done) {
              const ds = c.s - e.s;
              const lat = Math.abs(c.lateral - 1.9);
              if (ds < minDs) { minDs = ds; minDsSpeed = e.speedKmh; minLatAtMinDs = lat; }
            }
          }
          const crashed = ended?.crashed === true;
          // safety: never inside the crash cylinder (ds<2.2 & |lat|<1.4) above 3 km/h
          const inDanger = minDs < 2.2 && minLatAtMinDs < 1.4 && minDsSpeed > 3;
          if (crashed || inDanger) {
            failures++;
            console.log(`FALLO lat0=${lat0} dogV=${dogV} car=${carKmh}km/h dist=${dist}: crashed=${crashed} ${ended?.reason ?? ""} minDs=${minDs.toFixed(1)} lat=${minLatAtMinDs.toFixed(2)} v=${minDsSpeed.toFixed(0)}`);
          }
        }
      }
    }
  }
  console.log(failures === 0
    ? `OK: ${latStarts.length * dogSpeeds.length * carSpeeds.length * dists.length} escenarios de perro rápido sin crash ni intrusión`
    : `${failures} escenarios fallaron`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
