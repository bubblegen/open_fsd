import type { DecideResponse, PerceptionState, SpeedAction, CruiseChoice } from "@contracts/ai";
import type { RouteData } from "@contracts/geo";
import {
  Polyline,
  roundedPolyline,
  createProjection,
  stepsWithS,
  limitForStep,
  roadHalfAt,
  instructionFor,
  type Projection,
} from "./geo";

/* ────────────────────────────────────────────────────────────────
   Constants
──────────────────────────────────────────────────────────────── */

const DECISION_INTERVAL_S = 0.9;
const MAX_SPEED = 130;
const ACCEL = 15; // km/h per second — brisk EV takeoff, 0→50 in ~3.5 s
const BRAKE = 30;
const EMERGENCY_BRAKE = 40;
const DRAG = 1;
const DANGER_THRESHOLD = 0.55;
const FIXED_STEP_S = 0.05;
const MAX_CATCHUP_S = 2.0;

/* deterministic pseudo-random in [0,1) from any number */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
const MANEUVER_SAFE_THRESHOLD = 0.4;
const HARD_BRAKE_INCIDENT = 34; // above BRAKE (30): only true emergency braking counts
const LANE = 1.9; // meters, right-hand traffic
const CAR_LEN_M = 4.6;
const ARRIVE_WINDOW_M = 12;

/* ────────────────────────────────────────────────────────────────
   Types
──────────────────────────────────────────────────────────────── */

export type EngineStatus = "running" | "thinking" | "error" | "ended";
export type GameMode = "autopilot" | "human";

export type TrafficKind = "car" | "taxi" | "truck" | "police" | "ambulance";

export interface TrafficCar {
  id: number;
  s: number; // arc length along route
  dir: 1 | -1;
  speedMs: number;
  baseSpeedMs: number;
  kind: TrafficKind;
  color: string;
  changing: boolean; // overtaking wiggle
  latOff?: number; // extra lateral offset (pulled to the curb when we pass)
}

export interface CrossingEntity {
  id: number;
  s: number;
  lateral: number; // current lateral offset (crossing)
  from: number; // start lateral
  to: number; // target lateral
  speed: number; // m/s lateral
  kind: "persona" | "perro";
  done: boolean;
}

export interface ManeuverView {
  s: number;
  type: string;
  modifier: string;
  instruction: string;
  distanceM: number;
}

export interface DecisionLogEntry {
  tick: number;
  speedAction: SpeedAction;
  cruise: CruiseChoice;
  danger: number;
  maneuverSafe: number;
  confidence: number;
  latencyMs: number;
  source: "jev" | "human";
}

export interface Snapshot {
  tick: number;
  status: EngineStatus;
  speedKmh: number;
  speedLimitKmh: number;
  roadName: string;
  progressPct: number;
  remainingM: number;
  nextManeuver: ManeuverView | null;
  afterNext: string | null;
  cruiseActive: boolean;
  cruiseTargetKmh: number | null;
  score: number;
  distanceM: number;
  incidents: number;
  decisions: number;
  autopilot: boolean;
  emergency: boolean;
}

export interface TripResult {
  score: number;
  distanceM: number;
  durationS: number;
  decisions: number;
  incidents: number;
  destinationsReached: number; // maneuvers completed
  crashed: boolean;
  arrived: boolean;
  reason: string;
}

export interface DecisionView {
  tick: number;
  perception: PerceptionState;
  response: DecideResponse | null;
  pending: boolean;
  humanApplied: boolean;
  mode: GameMode;
}

export interface EngineCallbacks {
  onFrame: (snap: Snapshot) => void;
  onDecision: (view: DecisionView) => void;
  onLog: (entry: DecisionLogEntry) => void;
  onTripEnd: (result: TripResult) => void;
  onError: (message: string) => void;
  requestDecision: (state: PerceptionState) => Promise<DecideResponse>;
}

let uid = 1;

const MAJOR_TYPES = new Set([
  "turn",
  "roundabout",
  "rotary",
  "exit roundabout",
  "exit rotary",
  "fork",
  "merge",
  "on ramp",
  "off ramp",
  "arrive",
]);

/* ────────────────────────────────────────────────────────────────
   Engine
──────────────────────────────────────────────────────────────── */

export interface EngineOptions {
  /** wall-clock ms between decisions (0 = every tick; used by tests) */
  decisionEveryMs?: number;
}

export class AutopilotGame {
  private cb: EngineCallbacks;
  private timer: number | null = null;
  private raf: number | null = null;
  private lastTs = 0;
  private elapsed = 0;
  private simTime = 0;
  private lastDecisionWall = 0;
  private lastDecisionSim = -999;
  private decisionSentWall = 0;
  private stoppedTime = 0;
  private brakeTag: string | null = null;
  public incidentCauses: Record<string, number> = {};
  public overspeedS = 0; // time spent above limit+3 while moving
  public topOverKmh = 0; // worst overspeed vs current limit
  private overtakeId: number | null = null; // stopped car we are creeping past
  private blockedWaitS = 0; // time spent waiting behind a stopped car
  private teslaLat = LANE; // lateral offset (shifts toward centre to pass)
  private consecFails = 0;
  private errorNotified = false;
  private decisionEveryMs: number;
  private stuckBehindS = 0;
  private pendingDecision = false;

  // route
  proj: Projection;
  poly: Polyline;
  steps: ReturnType<typeof stepsWithS>;
  totalM: number;
  destLocal: { x: number; y: number };

  // Tesla
  private s = 0;
  private speedKmh = 0;
  private accelCmd: SpeedAction = "accelerate";
  private emergency = false;
  private cruiseActive = false;
  private cruiseTargetKmh: number | null = null;

  // world
  private traffic: TrafficCar[] = [];
  private crossings: CrossingEntity[] = [];
  private spawnTimer = 0;
  private crossSpawnTimer = 0;

  // stats
  private tick = 0;
  private score = 0;
  private distanceM = 0;
  private incidents = 0;
  private decisions = 0;
  private maneuversDone = 0;
  private lastDecel = 0;
  private crashed = false;
  private arrived = false;
  private startedAt = 0;
  private nextManeuverIdx = 0;

  mode: GameMode = "autopilot";
  status: EngineStatus = "running";
  currentDecision: DecisionView | null = null;
  route: RouteData;

  constructor(route: RouteData, cb: EngineCallbacks, opts: EngineOptions = {}) {
    this.route = route;
    this.cb = cb;
    this.decisionEveryMs = opts.decisionEveryMs ?? DECISION_INTERVAL_S * 1000;
    const [lon0, lat0] = route.points[0];
    this.proj = createProjection(lon0, lat0);
    const rawPoly = new Polyline(route.points.map(([lon, lat]) => this.proj.toLocal(lon, lat)));
    // smooth the OSRM sharp vertices so the car traces — and the painted
    // trajectory shows — a clean curve through turns (GTA-style racing line)
    this.poly = roundedPolyline(rawPoly, 7);
    this.steps = stepsWithS(this.poly, this.proj, route.steps);
    this.totalM = this.poly.total;
    const [dLon, dLat] = route.points[route.points.length - 1];
    this.destLocal = this.proj.toLocal(dLon, dLat);
    this.nextManeuverIdx = this.findNextManeuver(0);
    for (let i = 0; i < 5; i++) this.spawnTraffic(true);
  }

  /* ── lifecycle ────────────────────────────────────────────── */

  start() {
    this.startedAt = performance.now();
    this.lastTs = performance.now();
    // setInterval instead of rAF: the simulation must keep running even if
    // the browser throttles rAF (background tab, headless). Rendering happens
    // inside update() at up to ~30 fps, which is plenty for this view.
    // Drive the sim from BOTH rAF (smooth when the tab is visible) and a
    // wall-clock interval with sub-step catch-up (keeps ~real time even when
    // Chromium throttles hidden/headless pages to 1 Hz timers). Whichever
    // fires more often leads; the wall-delta makes them cooperate without
    // double-advancing.
    const tick = () => {
      const now = performance.now();
      let remaining = Math.min((now - this.lastTs) / 1000, MAX_CATCHUP_S);
      this.lastTs = now;
      while (remaining > 1e-4) {
        const dt = Math.min(remaining, FIXED_STEP_S);
        remaining -= dt;
        this.elapsed += dt;
        this.update(dt);
        if (this.status === "ended") break;
      }
      // render once per tick — a render per sub-step melts the main thread
      this.emitFrame();
    };
    this.timer = window.setInterval(tick, 250);
    const rafLoop = () => {
      if (this.timer === null) return; // stopped
      tick();
      this.raf = requestAnimationFrame(rafLoop);
    };
    this.raf = requestAnimationFrame(rafLoop);
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  setMode(mode: GameMode) {
    this.mode = mode;
  }

  endTrip() {
    if (this.status === "ended") return;
    this.status = "ended";
    this.cb.onTripEnd({
      score: Math.round(this.score),
      distanceM: Math.round(this.distanceM),
      durationS: Math.round(this.simTime),
      decisions: this.decisions,
      incidents: this.incidents,
      destinationsReached: this.maneuversDone,
      crashed: this.crashed,
      arrived: this.arrived,
      reason: this.arrived
        ? "Has llegado a tu destino"
        : this.crashed
          ? (this.crashReason ?? "Accidente")
          : "Viaje finalizado",
    });
  }

  /* ── traffic spawning ─────────────────────────────────────── */

  private spawnTraffic(initial = false) {
    const forward = this.traffic.filter((t) => t.dir === 1).length;
    const oncoming = this.traffic.filter((t) => t.dir === -1).length;
    const limit = this.currentLimit();
    const roll = Math.random();
    if (roll < 0.62 && forward < 7) {
      const kind: TrafficKind =
        Math.random() < 0.06 ? "truck" : Math.random() < 0.25 ? "taxi" : "car";
      // realistic flow: cars cruise a bit above the limit; trucks are capped
      // by law (90 on motorways, ~80 on national roads) — Google-style times
      // assume you overtake the slow ones, not follow them for 30 minutes
      let baseKmh: number;
      if (kind === "truck") {
        baseKmh = limit >= 100 ? 90 : limit >= 80 ? 80 : Math.max(32, limit * 0.8);
      } else {
        baseKmh = Math.min(limit + 2 + Math.random() * 8, 132);
      }
      const s = this.s + (initial ? 120 + Math.random() * 600 : 320 + Math.random() * 500);
      this.traffic.push({
        id: uid++,
        s,
        dir: 1,
        speedMs: (baseKmh / 3.6) as number,
        baseSpeedMs: baseKmh / 3.6,
        kind,
        color: ["#8e99a8", "#a86f5c", "#5c7a99", "#7a8c5c", "#99685c", "#c2c7ce"][
          Math.floor(Math.random() * 6)
        ],
        changing: false,
        latOff: 0,
      });
    } else if (oncoming < 5) {
      const kind: TrafficKind =
        Math.random() < 0.25 ? "police" : Math.random() < 0.3 ? "ambulance" : "car";
      const extra = kind === "car" ? 0 : 12; // emergency services rush
      const s = this.s + (initial ? 200 + Math.random() * 600 : 350 + Math.random() * 550);
      this.traffic.push({
        id: uid++,
        s,
        dir: -1,
        speedMs: (Math.min(limit + extra, 130) / 3.6) as number,
        baseSpeedMs: Math.min(limit + extra, 130) / 3.6,
        kind,
        color: kind === "police" ? "#22262c" : kind === "ambulance" ? "#f0f2f5" : "#8e99a8",
        changing: false,
        latOff: 0,
      });
    }
  }

  private lastCrossingDoneWall = -99999;
  private lastCrossingS = -999;

  private spawnCrossing() {
    if (this.crossings.length >= 3) return;
    // cooldown so a stopped car gets a window to proceed after one crosses
    if (performance.now() - this.lastCrossingDoneWall < 8000) return;
    // spawn at upcoming maneuver locations (intersections)
    const man = this.nextManeuver();
    const candidates = [man?.s, this.peekManeuver(1)?.s]
      .filter((v): v is number => typeof v === "number" && v > this.s + 25)
      .filter((v) => Math.abs(v - this.s) < 450)
      .filter((v) => Math.abs(v - this.lastCrossingS) > 30);
    if (candidates.length === 0 || Math.random() < 0.35) return;
    const s = candidates[Math.floor(Math.random() * candidates.length)] + (Math.random() * 14 - 4);
    const dir = Math.random() < 0.5 ? 1 : -1;
    const isDog = Math.random() < 0.22;
    // cross from sidewalk to sidewalk, whatever the road width here
    const walk = roadHalfAt(this.steps, s) + 1.1;
    this.crossings.push({
      id: uid++,
      s,
      lateral: -dir * walk,
      from: -dir * walk,
      to: dir * walk,
      speed: isDog ? 2.6 + Math.random() : 1.1 + Math.random() * 0.5,
      kind: isDog ? "perro" : "persona",
      done: false,
    });
  }

  /* ── perception ───────────────────────────────────────────── */

  private currentStepIdx(): number {
    let idx = 0;
    for (let i = 0; i < this.steps.length; i++) {
      if (this.steps[i].s <= this.s + 0.5) idx = i;
      else break;
    }
    return idx;
  }

  private currentLimit(): number {
    return limitForStep(this.steps[this.currentStepIdx()] ?? this.steps[0], this.currentStepIdx());
  }

  private currentRoadName(): string {
    return this.steps[this.currentStepIdx()]?.name || "vía sin nombre";
  }

  private findNextManeuver(fromIdx: number): number {
    for (let i = Math.max(0, fromIdx); i < this.steps.length; i++) {
      if (this.steps[i].s > this.s + 3 && MAJOR_TYPES.has(this.steps[i].type)) return i;
    }
    return -1;
  }

  private nextManeuver(): ManeuverView | null {
    let idx = this.nextManeuverIdx;
    if (idx >= 0 && this.steps[idx].s <= this.s + 3) {
      // we just passed this maneuver
      this.maneuversDone++;
      this.score += 150;
    }
    if (idx < 0 || this.steps[idx].s <= this.s + 3) {
      idx = this.findNextManeuver(idx < 0 ? 0 : idx);
      this.nextManeuverIdx = idx;
    }
    if (idx < 0) return null;
    const st = this.steps[idx];
    return {
      s: st.s,
      type: st.type,
      modifier: st.modifier,
      instruction: instructionFor(st),
      distanceM: Math.max(0, st.s - this.s),
    };
  }

  private peekManeuver(ahead: number): ManeuverView | null {
    let found = -1;
    let count = 0;
    for (let i = Math.max(0, this.nextManeuverIdx); i < this.steps.length; i++) {
      if (this.steps[i].s <= this.s + 3 || !MAJOR_TYPES.has(this.steps[i].type)) continue;
      if (count === ahead) {
        found = i;
        break;
      }
      count++;
    }
    if (found < 0) return null;
    const st = this.steps[found];
    return { s: st.s, type: st.type, modifier: st.modifier, instruction: instructionFor(st), distanceM: Math.max(0, st.s - this.s) };
  }

  private nearestAhead(): TrafficCar | null {
    let best: TrafficCar | null = null;
    for (const t of this.traffic) {
      if (t.dir !== 1) continue;
      const ds = t.s - this.s;
      if (ds > 0.5 && ds < 150 && (!best || t.s < best.s)) best = t;
    }
    return best;
  }

  private vehicleAhead(): { type: string; distanceM: number; speedKmh: number } | null {
    let best: TrafficCar | null = null;
    for (const t of this.traffic) {
      if (t.dir !== 1) continue;
      const ds = t.s - this.s;
      if (ds > 0.5 && ds < 150 && (!best || t.s < best.s)) best = t;
    }
    if (!best) return null;
    const ds = best.s - this.s;
    const kindName: Record<TrafficKind, string> = {
      car: "coche",
      taxi: "taxi",
      truck: "camión",
      police: "coche de policía",
      ambulance: "ambulancia",
    };
    return { type: kindName[best.kind], distanceM: Math.round(ds), speedKmh: Math.round(best.speedMs * 3.6) };
  }

  private oncomingVehicle(): { type: string; distanceM: number; speedKmh: number } | null {
    let best: TrafficCar | null = null;
    for (const t of this.traffic) {
      if (t.dir !== -1) continue;
      const ds = t.s - this.s; // ahead positive
      if (ds > 1 && ds < 160 && (!best || ds < best.s - this.s)) best = t;
    }
    if (!best) return null;
    const kindName: Record<TrafficKind, string> = {
      car: "coche",
      taxi: "taxi",
      truck: "camión",
      police: "policía",
      ambulance: "ambulancia",
    };
    return { type: kindName[best.kind], distanceM: Math.round(best.s - this.s), speedKmh: Math.round(best.speedMs * 3.6) };
  }

  private emergencyVehicle(): { type: string; distanceM: number; speedKmh: number } | null {
    for (const t of this.traffic) {
      if (t.dir !== -1) continue;
      if (t.kind !== "police" && t.kind !== "ambulance") continue;
      const ds = t.s - this.s;
      if (ds > 1 && ds < 220) {
        return {
          type: t.kind === "police" ? "policía" : "ambulancia",
          distanceM: Math.round(ds),
          speedKmh: Math.round(t.speedMs * 3.6),
        };
      }
    }
    return null;
  }

  /** nearest relevant pedestrian, with lateral geometry for smart braking */
  private pedestrianAhead(): {
    kind: "persona" | "perro";
    distanceM: number;
    lateralM: number; // distance from our lane centre (0 = in our path)
    closing: boolean; // walking toward our lane
    clearsInS: number; // seconds until clear of our lane corridor
  } | null {
    let best: CrossingEntity | null = null;
    for (const c of this.crossings) {
      if (c.done) continue;
      const ds = c.s - this.s;
      // only report pedestrians that are actually relevant to the car now —
      // reporting ones 100 m away made Jev brake forever and stall the trip
      if (ds > -2 && ds < 45 && (!best || Math.abs(ds) < Math.abs(best.s - this.s))) best = c;
    }
    if (!best) return null;
    const dir = Math.sign(best.to - best.from) || 1;
    const lat = best.lateral - LANE;
    const closing = dir > 0 ? lat < 0 : lat > 0;
    // time until the pedestrian is outside our lane corridor (|lat| > 2.3 m)
    let clearsInS: number;
    if (Math.abs(lat) > 2.3) clearsInS = 0;
    else {
      const distToClear = 2.3 - Math.abs(lat);
      clearsInS = distToClear / Math.max(best.speed, 0.1);
    }
    return { kind: best.kind, distanceM: Math.round(best.s - this.s), lateralM: Math.round(lat * 10) / 10, closing, clearsInS: Math.round(clearsInS * 10) / 10 };
  }

  private buildPerception(): PerceptionState {
    const veh = this.vehicleAhead();
    const oncoming = this.oncomingVehicle();
    const emerg = this.emergencyVehicle();
    const ped = this.pedestrianAhead();
    const man = this.nextManeuver();
    const after = this.peekManeuver(1);
    const limit = this.currentLimit();
    const laneAhead = ped
      ? Math.abs(ped.lateralM) > 2.3
        ? `${ped.kind} cruzando, ya fuera de tu carril (${Math.abs(ped.lateralM).toFixed(0)} m)`
        : ped.closing
          ? `${ped.kind} a ${ped.distanceM} m cruzando HACIA tu carril, libre en ~${ped.clearsInS.toFixed(1)} s`
          : `${ped.kind} a ${ped.distanceM} m alejándose de tu carril`
      : emerg
        ? `Vehículo de emergencia (${emerg.type}) acercándose`
        : veh && veh.distanceM < 40
          ? `Ocupada: ${veh.type} a ${veh.distanceM} m`
          : oncoming && oncoming.distanceM < 40
            ? "Tráfico en sentido contrario cercano"
            : "Despejada: sin peatones ni vehículos delante";
    return {
      tick: this.tick,
      gps: {
        elapsedS: Math.round(this.simTime),
        speedKmh: Math.round(this.speedKmh),
        speedLimitKmh: limit,
        roadName: this.currentRoadName(),
        progressPct: Math.round((this.s / this.totalM) * 100),
        remainingM: Math.round(this.totalM - this.s),
        distanceToManeuverM: Math.round(man?.distanceM ?? 0),
        nextManeuver: man?.instruction ?? "Continúa hasta el destino",
        maneuverType: man?.type ?? "continue",
        maneuverModifier: man?.modifier ?? "straight",
        afterNextManeuver: after ? after.instruction : null,
        cruiseActive: this.cruiseActive,
        cruiseTargetKmh: this.cruiseTargetKmh,
        fastRoad: limit >= 90,
      },
      traffic: {
        laneAhead,
        viaDespejada: !ped && !veh,
        vehicleAhead: veh,
        oncomingVehicle: oncoming,
        emergencyVehicle: emerg,
        pedestrian: ped,
      },
    };
  }

  /* ── decision loop ────────────────────────────────────────── */

  private maybeDecide(_dt: number) {
    if (this.status === "ended") return;
    // pace decisions by wall clock so throttled tabs still decide on time
    const now = performance.now();
    // a request that never settles (hung upstream fetch) must not freeze the
    // loop forever: give up after 12 s, brake for safety and keep going
    if (this.pendingDecision) {
      if (now - this.decisionSentWall < 12000) return;
      this.pendingDecision = false;
      this.noteDecisionFailure("Jev no respondió a tiempo; reintentando…");
    }
    // pace decisions in SIMULATION time so throttled tabs get the same
    // behaviour as visible ones (wall-clock pacing made commands alternate
    // faster than the physics could apply them and the car averaged to 0)
    if (this.decisionEveryMs > 0 && this.simTime - this.lastDecisionSim < this.decisionEveryMs / 1000) return;
    this.lastDecisionSim = this.simTime;
    this.lastDecisionWall = now;
    this.decisionSentWall = now;
    this.tick++;
    this.pendingDecision = true;

    const state = this.buildPerception();
    this.currentDecision = {
      tick: this.tick,
      perception: state,
      response: null,
      pending: true,
      humanApplied: false,
      mode: this.mode,
    };
    this.cb.onDecision(this.currentDecision);
    this.status = "thinking";

    this.cb
      .requestDecision(state)
      .then((res) => this.handleJevResponse(res, state))
      .catch((err: unknown) => {
        this.pendingDecision = false;
        this.noteDecisionFailure(err instanceof Error ? err.message : "Error al consultar a Jev");
        if (this.currentDecision) {
          this.currentDecision.pending = false;
          this.cb.onDecision(this.currentDecision);
        }
      });
  }

  /**
   * Transient API failures must never kill the session: the first failures
   * brake gently (safe stop), but if the API keeps failing the car creeps in
   * "maintain" so the trip degrades gracefully instead of freezing on the
   * road. Recovers automatically on the next successful decision.
   */
  private noteDecisionFailure(msg: string) {
    this.consecFails++;
    this.status = "error";
    this.accelCmd = this.consecFails < 3 ? "brake" : "maintain";
    if (!this.errorNotified) {
      this.errorNotified = true;
      this.cb.onError(msg);
    }
    setTimeout(() => {
      if (this.status === "error") this.status = "running";
    }, 1500);
  }

  private handleJevResponse(res: DecideResponse, state: PerceptionState) {
    this.pendingDecision = false;
    if (this.status !== "ended") this.status = "running";
    this.decisions++;
    this.consecFails = 0;
    this.errorNotified = false;

    const view: DecisionView = {
      tick: this.tick,
      perception: state,
      response: res,
      pending: false,
      humanApplied: false,
      mode: this.mode,
    };
    this.currentDecision = view;
    this.cb.onDecision(view);

    if (this.mode === "autopilot") {
      this.applyDecision(
        res.answers.speed_action.choice as SpeedAction,
        res.answers.cruise.choice as CruiseChoice,
        res.answers.immediate_danger.noul,
        res.answers.maneuver_ok.noul,
        "jev",
      );
    }
  }

  private applyDecision(
    speed: SpeedAction,
    cruise: CruiseChoice,
    danger: number,
    maneuverSafe: number,
    source: "jev" | "human",
  ) {
    const limit = this.currentLimit();
    this.emergency = danger >= DANGER_THRESHOLD;
    this.accelCmd = speed;

    // cruise management (Jev can only arm it on fast roads)
    if (cruise === "off") {
      this.cruiseActive = false;
      this.cruiseTargetKmh = null;
    } else if (limit >= 80) {
      const target = cruise === "cruise_80" ? 80 : cruise === "cruise_100" ? 100 : 120;
      this.cruiseActive = true;
      this.cruiseTargetKmh = Math.min(target, limit + 10);
    } else {
      this.cruiseActive = false;
      this.cruiseTargetKmh = null;
    }

    // risky maneuver → slow down to take it; but never deadlock: once slow,
    // creep up to the junction so the maneuver distance keeps shrinking and
    // Jev gets a chance to mark it safe again
    if (!this.emergency && maneuverSafe < MANEUVER_SAFE_THRESHOLD) {
      if (this.speedKmh > 35) {
        // slow down progressively for the maneuver, not an emergency stop
        this.accelCmd = "brake";
        if (this.speedKmh > 55) this.incidents++;
      } else {
        this.accelCmd = "maintain";
      }
    }

    const view = this.currentDecision;
    const res = view?.response;
    this.cb.onLog({
      tick: this.tick,
      speedAction: speed,
      cruise,
      danger,
      maneuverSafe,
      confidence: res?.answers.speed_action.confidence ?? 0,
      latencyMs: res?.latencyMs ?? 0,
      source,
    });
  }

  applyHumanDecision(speed: SpeedAction, cruise: CruiseChoice) {
    if (this.mode !== "human" || !this.currentDecision) return;
    const res = this.currentDecision.response;
    this.applyDecision(
      speed,
      cruise,
      res?.answers.immediate_danger.noul ?? 0,
      res?.answers.maneuver_ok.noul ?? 1,
      "human",
    );
    this.currentDecision.humanApplied = true;
    this.cb.onDecision(this.currentDecision);
  }

  /* ── physics ──────────────────────────────────────────────── */

  private update(dt: number) {
    if (this.status === "ended") return;

    this.brakeTag = null;
    this.simTime += dt;
    this.spawnTimer += dt;
    this.crossSpawnTimer += dt;
    if (this.spawnTimer > 1.4) {
      this.spawnTimer = 0;
      this.spawnTraffic();
    }
    if (this.crossSpawnTimer > 2.2) {
      this.crossSpawnTimer = 0;
      this.spawnCrossing();
    }

    // advance traffic (simple car-following for same-direction flow)
    const ourLimit = this.currentLimit();
    for (const t of this.traffic) {
      // traffic obeys the limit signs of the stretch it is on: vehicles
      // spawned in a 50 zone must speed up once they reach the 120 motorway
      if (t.dir === 1) {
        const desired =
          t.kind === "truck"
            ? ourLimit >= 100
              ? 90
              : ourLimit >= 80
                ? 80
                : Math.max(30, ourLimit * 0.75)
            : Math.min(ourLimit + 2 + hash(t.id) * 8, 132);
        t.baseSpeedMs += (desired / 3.6 - t.baseSpeedMs) * Math.min(1, 0.4 * dt);
      }
      let v = t.baseSpeedMs;
      if (t.dir === 1) {
        for (const o of this.traffic) {
          if (o === t || o.dir !== 1) continue;
          const ds = o.s - t.s;
          if (ds > 0 && ds < 16 && o.speedMs < v) v = o.speedMs;
        }
        // don't rear-end a crossing pedestrian: ease off smoothly
        for (const c of this.crossings) {
          if (c.done) continue;
          const ds = c.s - t.s;
          if (ds > 0 && ds < 16) v = Math.min(v, Math.max(1.0, (ds - 5) * 0.45));
        }
      }
      // clamp accel/decel so braking chains are predictable (4.5 m/s² max
      // decel — a leader that slams less gives followers time to react)
      const dv = v - t.speedMs;
      t.speedMs += Math.sign(dv) * Math.min(Math.abs(dv), 4.5 * dt);
      t.s += t.dir * t.speedMs * dt;
    }
    this.traffic = this.traffic.filter((t) => {
      const ds = t.s - this.s;
      return ds > -220 && ds < 1400;
    });

    // crossings
    for (const c of this.crossings) {
      const step = c.speed * dt * Math.sign(c.to - c.from);
      c.lateral += step;
      if (Math.abs(c.lateral) >= Math.abs(c.to) && !c.done) {
        c.done = true;
        this.lastCrossingDoneWall = performance.now();
        this.lastCrossingS = c.s;
      }
    }
    this.crossings = this.crossings.filter((c) => !c.done || Math.abs(c.lateral) < 9);

    // ── Tesla speed ──
    const prevSpeed = this.speedKmh;
    const limit = this.currentLimit();
    const veh = this.vehicleAhead();
    const gapM = veh ? veh.distanceM : Infinity;
    const leader = this.nearestAhead();

    // a much slower vehicle ahead is eventually "overtaken" (it leaves the
    // road or we change lanes) so the trip doesn't stall behind rolling
    // roadblocks — threshold near the truck/legal-flow speed per road type
    let slowAhead: TrafficCar | null = null;
    for (const t of this.traffic) {
      if (t.dir !== 1) continue;
      const ds = t.s - this.s;
      // stopped cars are handled by the wait-then-overtake flow, not removed
      if (ds > 0.5 && ds < 60 && t.speedMs * 3.6 < limit * 0.85 && t.speedMs * 3.6 > 3) slowAhead = t;
    }
    if (slowAhead && this.speedKmh < limit * 0.8) {
      this.stuckBehindS += dt;
      if (this.stuckBehindS > 6) {
        this.stuckBehindS = 0;
        this.traffic = this.traffic.filter((t) => t.id !== slowAhead!.id);
      }
    } else {
      this.stuckBehindS = Math.max(0, this.stuckBehindS - dt * 2);
    }

    // pedestrian-aware brake gating: if Jev says brake but trajectory math
    // shows the pedestrian will have cleared our lane corridor well before we
    // get there, downgrade to maintain and glide — no needless full stop.
    // Conversely, when a stop IS needed, brake progressively by distance.
    const pedNow = this.pedestrianAhead();
    let pedBrakeFactor = 1;
    if (pedNow) {
      const ds = pedNow.distanceM;
      if (ds > 4) {
        const tArrive = ds / Math.max(this.speedKmh / 3.6, 0.6);
        const clearsBeforeArrival = pedNow.clearsInS < tArrive - 0.8;
        if (clearsBeforeArrival && !this.emergency && this.accelCmd === "brake") {
          this.accelCmd = "maintain";
        }
      }
      // progressive: gentle far, firm close
      pedBrakeFactor = ds < 10 ? 1 : ds < 22 ? 0.6 : 0.35;
    }

    if (this.overtakeId !== null) {
      // passing a stopped car: speed is owned by the overtake block below
    } else if (this.emergency) {
      this.speedKmh = Math.max(0, this.speedKmh - EMERGENCY_BRAKE * dt);
      this.brakeTag = "emergency";
    } else if (this.cruiseActive && this.cruiseTargetKmh !== null && this.accelCmd !== "brake") {      // adaptive cruise: hold target, keep 2-second gap to vehicle ahead
      const target = Math.min(this.cruiseTargetKmh, limit);
      const safeGap = (this.speedKmh / 3.6) * 2 + 6;
      if (veh && gapM < safeGap) {
        this.speedKmh = Math.max(0, this.speedKmh - BRAKE * dt);
        this.brakeTag = "cruise-gap";
      } else if (this.speedKmh < target - 2) {
        this.speedKmh = Math.min(target, this.speedKmh + ACCEL * dt);
      } else if (this.speedKmh > target + 2) {
        this.speedKmh = Math.max(0, this.speedKmh - DRAG * 3 * dt);
      } else {
        this.speedKmh = Math.max(0, this.speedKmh - DRAG * dt);
      }
    } else {
      const leaderV = leader ? leader.speedMs * 3.6 : null;
      switch (this.accelCmd) {
        case "accelerate": {
          // respect a safe following distance even when Jev says go;
          // approach the leader smoothly instead of brake-accel oscillation
          const safeGap = (this.speedKmh / 3.6) * 2.0 + 6;
          if (veh && gapM < safeGap * 0.7) {
            this.speedKmh = Math.max(0, this.speedKmh - BRAKE * dt);
            this.brakeTag = "acc-gap-hard";
          } else if (veh && gapM < safeGap && leaderV !== null) {
            if (this.speedKmh > leaderV + 1) {
              this.speedKmh = Math.max(leaderV, this.speedKmh - BRAKE * 0.6 * dt);
              this.brakeTag = "acc-leader";
            } else if (this.speedKmh < leaderV - 2) {
              this.speedKmh = Math.min(leaderV, this.speedKmh + ACCEL * 0.7 * dt);
            }
          } else {
            // strict limit compliance: never use the road above its limit
            this.speedKmh = Math.min(Math.max(limit, 20), MAX_SPEED, this.speedKmh + ACCEL * dt);
          }
          break;
        }
        case "brake": {
          // graduated comfort braking: only a true close conflict is a hard
          // stop; a cautious "brake" from the model eases off instead of
          // slamming to 0 km/h (which used to chain stop→creep→stop loops)
          const factor = pedNow
            ? pedBrakeFactor
            : veh && gapM < 14
              ? 1
              : 0.5;
          this.speedKmh = Math.max(0, this.speedKmh - BRAKE * factor * dt);
          this.brakeTag = "jev-brake";
          break;
        }
        case "maintain": {
          // never coast into the vehicle ahead: keep a safe gap and match it
          const safeGap = (this.speedKmh / 3.6) * 2.0 + 6;
          if (veh && gapM < safeGap * 0.75) {
            this.speedKmh = Math.max(0, this.speedKmh - BRAKE * dt);
            this.brakeTag = "maint-gap";
            break;
          }
          if (veh && gapM < safeGap && leaderV !== null) {
            if (this.speedKmh > leaderV + 1) {
              this.speedKmh = Math.max(leaderV, this.speedKmh - BRAKE * 0.7 * dt);
              this.brakeTag = "maint-leader";
            } else if (this.speedKmh < leaderV - 3) {
              this.speedKmh = Math.min(leaderV, this.speedKmh + ACCEL * 0.7 * dt);
            }
            break;
          }
          if (this.speedKmh < 6) {
            // creep once the pedestrian is clearing our corridor (or gone),
            // not only when they are 12 m past us — shorter, realistic stops
            const clear = !pedNow || Math.abs(pedNow.lateralM) > 2.2 || pedNow.clearsInS < 1.2;
            if ((!veh || gapM > 9) && clear) {
              this.speedKmh = Math.min(14, this.speedKmh + 8 * dt); // creep back up briskly after a stop
              break;
            }
          }
          // hold speed instead of sawtooth coasting: bleed only when a hair
          // above the limit (Jev says "maintain", not "slow down")
          if (this.speedKmh > limit + 0.5) {
            this.speedKmh = Math.max(limit, this.speedKmh - DRAG * 1.5 * dt);
          }
          break;
        }
      }
    }
    // proactive limit compliance: if a LOWER limit starts within ~170 m,
    // shed speed with a comfortable decel so we enter the zone at the limit
    // (never blast through a 30 sign at the previous road's speed)
    if (!this.emergency && this.accelCmd !== "brake") {
      let zoneS = Infinity;
      let zoneLim = Infinity;
      for (const st of this.steps) {
        if (st.s <= this.s + 3) continue;
        if (st.s > this.s + 170) break;
        const l = limitForStep(st, st.index);
        if (l < zoneLim) {
          zoneLim = l;
          zoneS = st.s;
        }
      }
      if (zoneLim < this.speedKmh - 1) {
        const dist = Math.max(zoneS - this.s, 6);
        const vMs = this.speedKmh / 3.6;
        const limMs = zoneLim / 3.6;
        const needMs2 = Math.max(0, (vMs * vMs - limMs * limMs) / (2 * dist));
        const decel = Math.min(BRAKE * 0.55, Math.max(1.2, needMs2 * 3.6));
        this.speedKmh = Math.max(zoneLim, this.speedKmh - decel * dt);
        this.brakeTag = "limit-ahead";
      }
    }
    // wait-then-overtake: a FULLY STOPPED car blocks our lane. Real behaviour:
    // wait a few seconds, then creep past it at walking pace while it pulls
    // toward the curb and we shift toward the centre line (never a pass-through)
    if (this.overtakeId !== null) {
      const t = this.traffic.find((x) => x.id === this.overtakeId);
      if (!t || this.s > t.s + CAR_LEN_M + 1.5) {
        this.overtakeId = null; // passed it (or it disappeared)
      } else {
        t.latOff = Math.min(1.35, (t.latOff ?? 0) + dt * 0.9); // it yields to the curb
        this.teslaLat = Math.max(LANE - 1.05, this.teslaLat - dt * 0.9); // we hug the line
        if (!this.emergency) {
          this.speedKmh = Math.min(this.speedKmh, 6); // walking pace past it
          if (this.speedKmh < 5) this.speedKmh = Math.min(5, this.speedKmh + 5 * dt);
        }
      }
    }
    if (this.overtakeId === null) {
      // relax back into our lane once the pass is done
      this.teslaLat += (LANE - this.teslaLat) * Math.min(1, dt * 1.2);
      if (leader && leader.speedMs * 3.6 < 3 && gapM < 16 && this.speedKmh < 3) {
        this.blockedWaitS += dt;
        if (this.blockedWaitS > 6) {
          this.overtakeId = leader.id; // enough waiting — pass it slowly
          this.blockedWaitS = 0;
        }
      } else {
        this.blockedWaitS = 0;
      }
    }
    // telemetry: any real overspeed time (limit+3 while moving)
    if (this.speedKmh > 5 && this.speedKmh > limit + 3) {
      this.overspeedS += dt;
      this.topOverKmh = Math.max(this.topOverKmh, this.speedKmh - limit);
    }
    // ── REFLEX LAYER (AEB): safety is not negotiated with the model ──
    // Jev answers every ~1 s; a pedestrian stepping in between decisions must
    // still trigger braking. If the pedestrian will be inside our corridor on
    // arrival, cap our speed so we arrive just after they clear — no matter
    // what accelCmd says. Same for a vehicle we're closing on too fast.
    if (!this.emergency) {
      const vMs = this.speedKmh / 3.6;
      if (pedNow && pedNow.distanceM > 0.1 && pedNow.distanceM < 60) {
        const ds = pedNow.distanceM;
        // walkers heading for our lane get a wider early corridor so we shed
        // speed PROGRESSIVELY (no last-metre emergency slam → no incidents);
        // dogs are erratic → always wide corridor and a near-stop cap
        const corridor = pedNow.closing || pedNow.kind === "perro" ? 2.7 : 1.7;
        if (Math.abs(pedNow.lateralM) < corridor && pedNow.clearsInS > 0.05) {
          const tArrive = ds / Math.max(vMs, 0.6);
          if (pedNow.clearsInS > tArrive - 0.55) {
            const cap = pedNow.kind === "perro" ? 3.0 : 4.5;
            let vAllowMs = Math.min(ds / (pedNow.clearsInS + 0.45), cap);
            // they are directly in front of us RIGHT NOW: stop behind them
            // (creep to ~3 m), never roll through at crossing speed
            if (Math.abs(pedNow.lateralM) < 1.1) {
              vAllowMs = Math.min(vAllowMs, Math.max((ds - 3.2) / 1.5, 0));
            }
            if (vMs > vAllowMs + 0.25) {
              const needMs2 = (vMs * vMs - vAllowMs * vAllowMs) / (2 * Math.max(ds - 1.5, 1));
              // exact needed decel when possible; only a true close call (<12 m)
              // deserves a hard stop
              const floor = ds < 12 ? BRAKE * 0.8 : 6;
              const decel = Math.min(EMERGENCY_BRAKE, Math.max(floor, needMs2 * 3.6));
              this.speedKmh = Math.max(vAllowMs * 3.6, this.speedKmh - decel * dt);
              this.brakeTag = "aeb-ped";
            }
          }
        }
      }
      // vehicle AEB: any closing > 0.4 m/s sheds speed early and
      // progressively. The engage window scales with closing speed — the
      // distance a comfortable 3.5 m/s² stop needs plus a small buffer — so
      // even a motorway-speed approach to a stopped car starts braking in
      // time (before, the fixed 34 m window made 120→0 a guaranteed crash).
      if (veh && (!leader || leader.id !== this.overtakeId)) {
        const leaderMs = leader ? leader.speedMs : 0;
        const closingMs = vMs - leaderMs;
        const window = Math.min(150, (closingMs * closingMs) / 7 + 14);
        if (closingMs > 0.4 && gapM < window) {
          const needMs2 = (closingMs * closingMs) / (2 * Math.max(gapM - 5, 1));
          const decel = Math.min(EMERGENCY_BRAKE, Math.max(5, needMs2 * 3.6));
          if (vMs > leaderMs + 0.3) {
            this.speedKmh = Math.max(leaderMs * 3.6, this.speedKmh - decel * dt);
            this.brakeTag = "aeb-veh";
          }
        }
      }
    }
    // stuck detector: if we're stopped with nothing in front for a while,
    // Jev's last order can't be trusted — nudge to maintain, then accelerate
    if (this.speedKmh < 0.5) {
      const pedStopped = this.pedestrianAhead();
      const pedBlocking = pedStopped && Math.abs(pedStopped.lateralM) <= 2.2 && pedStopped.clearsInS > 1.2;
      if ((!veh || gapM > 12) && !pedBlocking) {
        this.stoppedTime += dt;
        if (this.stoppedTime > 2.5 && this.accelCmd === "brake") this.accelCmd = "maintain";
        if (this.stoppedTime > 6) this.accelCmd = "accelerate";
      } else {
        this.stoppedTime = 0;
      }
    } else {
      this.stoppedTime = 0;
    }

    const decel = (prevSpeed - this.speedKmh) / Math.max(dt, 0.001);
    if (decel > HARD_BRAKE_INCIDENT && this.lastDecel <= HARD_BRAKE_INCIDENT) {
      this.incidents++;
      this.incidentCauses[this.brakeTag ?? "unknown"] =
        (this.incidentCauses[this.brakeTag ?? "unknown"] ?? 0) + 1;
      this.score = Math.max(0, this.score - 25);
    }
    this.lastDecel = decel;

    // move
    this.s += (this.speedKmh / 3.6) * dt;
    this.distanceM += (this.speedKmh / 3.6) * dt;
    this.score += ((this.speedKmh / 3.6) * dt) / 8;

    // maneuvers completed (counted inside nextManeuver as they are passed)
    const man = this.nextManeuver();

    // arrival is checked every tick, independent of remaining maneuvers
    if (!this.arrived && this.s >= this.totalM - ARRIVE_WINDOW_M) {
      this.arrived = true;
      this.score += 1500;
      this.speedKmh = 0;
      return this.endTrip();
    }

    // crossing entity collision
    const carLat = LANE;
    for (const c of this.crossings) {
      if (c.done) continue;
      const ds = Math.abs(c.s - this.s);
      if (ds < 2.2 && Math.abs(c.lateral - carLat) < 1.4 && this.speedKmh > 3) {
        if (c.kind === "perro" && this.speedKmh <= 18) {
          this.incidents++;
          this.score = Math.max(0, this.score - 60);
          c.done = true; // scared dog runs off
        } else {
          return this.crash(`Atropello a un${c.kind === "perro" ? " perro" : " peatón"}`);
        }
      }
    }

    // rear-end: vehicles are SOLID at any speed. Bumper-to-bumper distance is
    // ds - CAR_LEN_M, so contact happens at ds ≈ CAR_LEN_M (the old trigger at
    // CAR_LEN_M*0.55 plus a speed>10 gate let slow cars be ghosted through).
    // While we are overtaking a stopped car we are laterally separated from
    // it, so it is exempt from the clamp (we must be allowed to get alongside).
    const passing = leader !== null && leader.id === this.overtakeId;
    if (veh && gapM <= CAR_LEN_M + 0.4 && !passing) {
      const closing = leader ? this.speedKmh - leader.speedMs * 3.6 : 99;
      if (closing > 18) {
        return this.crash(`Colisión por alcance con ${veh.type}`);
      }
      // light contact: count an incident, match speed, never pass through
      this.incidents++;
      this.score = Math.max(0, this.score - 50);
      this.speedKmh = Math.max(0, leader ? leader.speedMs * 3.6 : 0);
      this.brakeTag = "rear-end";
      if (leader) this.s = Math.min(this.s, leader.s - CAR_LEN_M - 0.3);
    }

    this.maybeDecide(dt);
  }

  /** pushed once per loop tick (not per physics sub-step) */
  private emitFrame() {
    if (this.status !== "ended") this.cb.onFrame(this.snapshot());
  }

  private crashReason: string | null = null;

  private crash(reason: string) {
    this.crashReason = reason;
    this.crashed = true;
    this.incidents++;
    this.speedKmh = 0;
    this.endTrip();
  }

  /* ── snapshots ────────────────────────────────────────────── */

  snapshot(): Snapshot {
    const man = this.nextManeuver();
    const after = this.peekManeuver(1);
    return {
      tick: this.tick,
      status: this.status,
      speedKmh: Math.round(this.speedKmh),
      speedLimitKmh: this.currentLimit(),
      roadName: this.currentRoadName(),
      progressPct: Math.min(100, Math.round((this.s / this.totalM) * 100)),
      remainingM: Math.round(this.totalM - this.s),
      nextManeuver: man,
      afterNext: after ? after.instruction : null,
      cruiseActive: this.cruiseActive,
      cruiseTargetKmh: this.cruiseTargetKmh,
      score: Math.round(this.score),
      distanceM: Math.round(this.distanceM),
      incidents: this.incidents,
      decisions: this.decisions,
      autopilot: this.mode === "autopilot",
      emergency: this.emergency,
    };
  }

  renderState() {
    return {
      proj: this.proj,
      poly: this.poly,
      s: this.s,
      car: this.poly.atOffset(this.s, this.teslaLat),
      accelCmd: this.accelCmd,
      autopilot: this.mode === "autopilot",
      speedKmh: this.speedKmh,
      limit: this.currentLimit(),
      cruiseActive: this.cruiseActive,
      cruiseTargetKmh: this.cruiseTargetKmh,
      emergency: this.emergency,
      traffic: this.traffic,
      crossings: this.crossings,
      laneOffset: LANE,
      dest: this.destLocal,
      nextManeuver: this.nextManeuver(),
      steps: this.steps,
      elapsed: this.elapsed,
      crashed: this.crashed,
      totalM: this.totalM,
      vehicleAhead: this.vehicleAhead(),
      oncoming: this.oncomingVehicle(),
      emergencyVehicle: this.emergencyVehicle(),
      pedestrian: this.pedestrianAhead(),
    };
  }
}

export type RenderState = ReturnType<AutopilotGame["renderState"]>;
