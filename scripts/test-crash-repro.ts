/** Reproduce the early-trip crash with the worst-case always-accelerate model
 *  and report the exact crash reason + context. */
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
  for (let run = 0; run < 6; run++) {
    let ended: { reason?: string; arrived?: boolean; crashed?: boolean } | null = null;
    const engine = new AutopilotGame(
      route,
      {
        onFrame: () => {},
        onDecision: () => {},
        onLog: () => {},
        onError: (m) => console.log(`  [engine error] ${m}`),
        onTripEnd: (r) => { ended = r; },
        requestDecision: accelerateAlways,
      },
      { decisionEveryMs: 900 },
    );
    const e = engine as any;
    for (let i = 0; i < 2400 && !ended; i++) { // 120 sim-seconds
      engine.update(0.05);
    }
    if (ended && ended.crashed) {
      console.log(`run ${run}: CRASH a los ${e.simTime.toFixed(0)}s v=${(e.speedKmh as number).toFixed(0)}km/h — ${ended.reason}`);
      const veh = e.vehicleAhead();
      const ped = e.pedestrianAhead();
      console.log(`  contexto: veh=${JSON.stringify(veh)} ped=${ped ? `${ped.distanceM}m lat=${ped.lateralM?.toFixed(1)}` : "-"} overtakeId=${e.overtakeId}`);
    } else {
      console.log(`run ${run}: ${ended ? ended.reason : "timeout"} (sin crash)`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
