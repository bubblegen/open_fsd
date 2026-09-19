/**
 * LIVE diagnosis: run a real Madrid route with the REAL TypeSafe Jev API
 * (through the local server, which holds the key) and log every decision,
 * the speed around it, and what the car perceived — to find why the car
 * keeps stopping / crawling at ~6 km/h.
 */
import { AutopilotGame } from "../src/game/engine";
import { DECISION_QUESTIONS, type PerceptionState } from "../contracts/ai";
import type { RouteData } from "../contracts/geo";
import { readFileSync } from "node:fs";

// load the key exactly like the server does (never committed)
const env = readFileSync(new URL("../.env", import.meta.url), "utf-8");
const KEY = env.match(/TYPESAFE_API_KEY=(.+)/)?.[1]?.trim();
if (!KEY) throw new Error("TYPESAFE_API_KEY missing in .env");

const ROUTE_URL =
  "http://localhost:3000/api/trpc/geo.route?input=" +
  encodeURIComponent(
    '{"json":{"fromLat":40.416863,"fromLon":-3.7038762,"toLat":40.4721,"toLon":-3.6823}}',
  );

const log: string[] = [];
let brakes = 0, accels = 0, maintains = 0, fails = 0, fullStops = 0, stopTime = 0;
let wasMoving = true;
const speedHist = { "<8": 0, "8-25": 0, "25-45": 0, ">=45": 0 };

let syncCalls = 0;
async function realJev(state: PerceptionState) {
  syncCalls++;
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: "jev-latest",
        state,
        questions: DECISION_QUESTIONS,
      }),
    });
    const lat = Date.now() - t0;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const data = (await res.json()) as {
      answers?: {
        speed_action?: { choice?: string; confidence?: number };
        cruise?: { choice?: string };
        maneuver_ok?: { noul?: number };
        immediate_danger?: { noul?: number };
      };
    };
    const a = data.answers ?? {};
    const choice = a.speed_action?.choice ?? "?";
    const ped = state.traffic.pedestrian;
    const line =
      `t=${state.gps.elapsedS?.toFixed(0) ?? "?"}s v=${state.gps.speedKmh} lim=${state.gps.speedLimitKmh} ` +
      `via=${state.traffic.viaDespejada} ped=${ped ? `${ped.distanceM}m lat=${ped.lateralM?.toFixed(1)} libre=${ped.clearsInS?.toFixed(1)}s` : "-"} ` +
      `veh=${state.traffic.vehicleAhead ? state.traffic.vehicleAhead.distanceM + "m" : "-"} ` +
      `man=${Math.round(state.gps.distanceToManeuverM)}m → ${choice}(${a.speed_action?.confidence}) ` +
      `peligro=${a.immediate_danger?.noul} cru=${a.cruise?.choice} [${lat}ms]`;
    log.push(line);
    if (choice === "brake") brakes++; else if (choice === "accelerate") accels++; else maintains++;
    return {
      model: "jev-live",
      answers: {
        speed_action: { type: "choice", choice, confidence: a.speed_action?.confidence ?? 0.5, probabilities: { accelerate: 0, maintain: 0, brake: 0 } },
        cruise: { type: "choice", choice: a.cruise?.choice ?? "off", confidence: 0.9, probabilities: { cruise_80: 0, cruise_100: 0, cruise_120: 0, off: 1 } },
        maneuver_ok: { type: "noul", noul: a.maneuver_ok?.noul ?? 0.9, confidence: 0.9 },
        immediate_danger: { type: "noul", noul: a.immediate_danger?.noul ?? 0.05, confidence: 0.9 },
      },
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  } catch (e) {
    fails++;
    log.push(`t=${state.gps.elapsedS?.toFixed(0) ?? "?"}s FALLA API after ${Date.now() - t0}ms: ${e instanceof Error ? e.message : e}`);
    // mirror the app's retry-then-fail flow is handled by Home.tsx; here throw
    throw e;
  }
}

async function main() {
  const res = await fetch(ROUTE_URL);
  const j = await res.json();
  const route = (j as { result: { data: { json: RouteData } } }).result.data.json;
  console.log("ROUTE fetched: distanceM=", route.distanceM, "points=", route.points.length, "steps=", route.steps.length);
  let ended: { arrived: boolean; crashed: boolean; reason?: string } | null = null;
  const engine = new AutopilotGame(
    route,
    {
      onFrame: () => {},
      onDecision: () => {},
      onLog: () => {},
      onError: (m) => log.push(`ENGINE ERROR: ${m}`),
      onTripEnd: (r) => { ended = r; },
      requestDecision: realJev,
    },
    { decisionEveryMs: 900 },
  );
  // REAL TIME: dt from the wall clock so Jev's API latency matches the browser
  let simT = 0;
  let lastWall = Date.now();
  while (!ended && simT < 12 * 60) {
    const now = Date.now();
    const dt = Math.min((now - lastWall) / 1000, 0.25);
    lastWall = now;
    if (dt <= 0) { await new Promise((r) => setTimeout(r, 15)); continue; }
    engine.update(dt);
    simT += dt;
    const spd = (engine as unknown as { speedKmh: number }).speedKmh;
    if (spd < 1) { stopTime += dt; if (wasMoving) { fullStops++; wasMoving = false; } }
    else if (spd > 8) wasMoving = true;
    if (spd < 8) speedHist["<8"] += dt;
    else if (spd < 25) speedHist["8-25"] += dt;
    else if (spd < 45) speedHist["25-45"] += dt;
    else speedHist[">=45"] += dt;
    await new Promise((r) => setTimeout(r, 8));
  }
  const mm = Math.floor(simT / 60), ss = String(Math.floor(simT % 60)).padStart(2, "0");
  console.log("syncCalls:", syncCalls);
  console.log(`\n══ RESULTADO: ${mm}:${ss} | brakes=${brakes} accels=${accels} maintains=${maintains} apiFails=${fails} fullStops=${fullStops} stopped=${stopTime.toFixed(0)}s`);
  console.log("tiempo por tramo:", Object.entries(speedHist).map(([k, v]) => `${k}:${v.toFixed(0)}s`).join("  "));
  console.log("═ últimas 45 decisiones ═");
  log.slice(-45).forEach((l) => console.log(" ", l));
  console.log("incidentCauses:", (engine as unknown as { incidentCauses: Record<string, number> }).incidentCauses);
  const tel = engine as unknown as { overspeedS: number; topOverKmh: number };
  console.log(`overspeed: ${tel.overspeedS.toFixed(1)}s por encima de límite+3 (peor exceso +${tel.topOverKmh.toFixed(0)} km/h)`);
  console.log("result:", ended);
}
main().catch((e) => { console.error(e); process.exit(1); });
