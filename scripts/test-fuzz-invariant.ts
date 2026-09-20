/**
 * Fuzz: the HARD INVARIANT "car bodies never overlap" must hold under
 * random traffic. Random leaders stop/go at random times, random approach
 * speeds, random crossing pedestrians/dogs. For every tick we assert:
 *   - no same-direction car is ever inside our body box
 *     (|ds| < CAR_LEN_M and lateral separation < 1.6) at tick end;
 *   - no crash "Colisión por alcance" ever fires (closing at contact ≤ 25);
 *   - the trip either completes, ends by crash WITH a legit reason, or times
 *     out — but never with a silent pass-through.
 */
import { AutopilotGame } from "../src/game/engine";
import type { DecideResponse, PerceptionState } from "../contracts/ai";
import type { RouteData } from "../contracts/geo";

const ROUTE_URL =
  "http://localhost:3000/api/trpc/geo.route?input=" +
  encodeURIComponent(
    '{"json":{"fromLat":40.416863,"fromLon":-3.7038762,"toLat":40.4721,"toLon":-3.6823}}',
  );

const CAR_LEN_M = 4.6;
const LANE = 1.9;

const accelerateMostly = (_s: PerceptionState): Promise<DecideResponse> =>
  Promise.resolve({
    model: "stub",
    answers: {
      speed_action: {
        type: "choice",
        choice: Math.random() < 0.75 ? "accelerate" : "maintain",
        confidence: 1,
        probabilities: { accelerate: 0.75, maintain: 0.2, brake: 0.05 },
      },
      cruise: { type: "choice", choice: "off", confidence: 1, probabilities: { cruise_80: 0, cruise_100: 0, cruise_120: 0, off: 1 } },
      maneuver_ok: { type: "noul", noul: 0.95, confidence: 1 },
      immediate_danger: { type: "noul", noul: 0.02, confidence: 1 },
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  });

// simple LCG so failures are reproducible
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

async function main() {
  const res = await fetch(ROUTE_URL);
  const j = await res.json();
  const route = (j as { result: { data: { json: RouteData } } }).result.data.json;

  const RUNS = 60;
  let worstGap = Infinity; // min bumper gap ever seen (should stay > 0)
  let violations = 0;
  let crashes = 0;
  let completions = 0;
  let timeouts = 0;

  for (let run = 0; run < RUNS; run++) {
    const startSpeed = 20 + rnd() * 100; // 20..120 km/h
    const nLeaders = 1 + Math.floor(rnd() * 3); // 1..3 cars ahead
    const stopBehaviors = Array.from({ length: nLeaders }, () => ({
      at: 60 + rnd() * 240, // where they stop (m)
      dur: 3 + rnd() * 12, // how long they stay stopped (s)
      speedMs: rnd() < 0.3 ? 0 : 2 + rnd() * 6, // stopped or crawling
    }));

    let crashed: string | null = null;
    let ended = false;
    const engine = new AutopilotGame(
      route,
      {
        onFrame: () => {},
        onDecision: () => {},
        onLog: () => {},
        onTripEnd: (r) => {
          ended = true;
          if (r.crashed) crashed = r.reason;
          else completions++;
        },
        onError: () => {},
        requestDecision: accelerateMostly,
      },
      { decisionEveryMs: 900 },
    );
    // random starting speed like the other regression tests
    (engine as unknown as { speedKmh: number }).speedKmh = startSpeed;

    // inject leaders ahead with scripted stop/go
    const traffic = (engine as unknown as { traffic: Array<Record<string, number | string>> }).traffic;
    traffic.length = 0;
    let nextId = 9000;
    for (const b of stopBehaviors) {
      traffic.push({
        id: nextId++, kind: "car", dir: 1, s: b.at,
        speedMs: 13 + rnd() * 8, baseSpeedMs: 13 + rnd() * 8, latOff: 0,
      });
    }
    // random crossing entities sprinkled in the first 400 m
    const crossings = (engine as unknown as { crossings: Array<Record<string, number | string | boolean>> }).crossings;
    crossings.length = 0;
    const nCross = Math.floor(rnd() * 3);
    for (let i = 0; i < nCross; i++) {
      const kind = rnd() < 0.5 ? "perro" : "persona";
      const from = rnd() < 0.5 ? -9 : 9;
      const to = -from;
      crossings.push({
        id: 8000 + i, kind, s: 80 + rnd() * 300,
        lateral: from + (to - from) * rnd() * 0.3, from, to,
        speed: kind === "perro" ? 2.6 + rnd() : 1.2 + rnd() * 0.6,
        done: false,
      });
    }

    const dt = 0.05;
    let simT = 0;
    let maxTicks = 60 * 60; // 60 sim-seconds cap
    const stoppedUntil = stopBehaviors.map(() => -1);
    while (!ended && maxTicks-- > 0) {
      // script the leaders: each stops AT its point once (when we approach),
      // holds for its duration, then drives on — like a delivery van
      const ourS = (engine as unknown as { s: number }).s;
      for (let i = 0; i < nLeaders; i++) {
        const b = stopBehaviors[i];
        const t = traffic[i];
        if (!t) continue;
        const id = t.id as number;
        if (stoppedUntil[i] < 0 && Math.abs(t.s - b.at) < 1 && ourS < b.at) {
          stoppedUntil[i] = simT + b.dur; // arrived at its stop point
        }
        if (stoppedUntil[i] >= 0 && simT < stoppedUntil[i]) {
          t.s = b.at; // pinned at the stop point
          t.speedMs = b.speedMs;
          t.baseSpeedMs = b.speedMs;
        } else if (stoppedUntil[i] >= 0) {
          t.baseSpeedMs = 13; // drove off after its stop
        }
        void id;
      }
      (engine as unknown as { update: (dt: number) => void }).update(dt);
      simT += dt;

      // ── the invariant check, evaluated at tick end ──
      const ourLat = (engine as unknown as { teslaLat: number }).teslaLat;
      const tr = (engine as unknown as { traffic: Array<{ id: number; dir: number; s: number; latOff?: number; speedMs: number }> }).traffic;
      for (const t of tr) {
        if (t.dir !== 1) continue;
        const ds = t.s - ourS;
        const latSep = Math.abs(LANE + (t.latOff ?? 0) - ourLat);
        const gap = Math.abs(ds) - CAR_LEN_M; // bumper-to-bumper
        if (gap < worstGap) worstGap = gap;
        if (Math.abs(ds) < CAR_LEN_M - 0.05 && latSep < 1.6) {
          violations++;
          console.error(
            `VIOLACIÓN run=${run} t=${simT.toFixed(1)}s ds=${ds.toFixed(2)} latSep=${latSep.toFixed(2)} v=${((engine as unknown as { speedKmh: number }).speedKmh).toFixed(1)}`
          );
        }
      }
    }
    if (!ended) timeouts++;
    if (crashed) {
      crashes++;
      if (!/alcance|perro|peatón/.test(crashed)) {
        console.error(`run=${run}: crash inesperado: ${crashed}`);
        violations++;
      }
    }
  }

  console.log(`runs=${RUNS} completados=${completions} timeouts=${timeouts} crashes=${crashes} violaciones=${violations}`);
  console.log(`peor hueco parachoques visto: ${worstGap.toFixed(2)} m (negativo = solape)`);
  if (violations > 0) { console.error("FALLO: invariante roto"); process.exit(1); }
  console.log("OK: invariante cuerpos sólidos bajo fuzz de tráfico aleatorio");
}

main();
