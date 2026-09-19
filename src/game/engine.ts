import type { DecideResponse, PerceptionState, SpeedAction, CruiseChoice } from "@contracts/ai";
import type { RouteData } from "@contracts/geo";
import {
  Polyline,
  createProjection,
  stepsWithS,
  limitForStep,
  instructionFor,
  type Projection,
} from "./geo";

/* ────────────────────────────────────────────────────────────────
   Constants
──────────────────────────────────────────────────────────────── */

const DECISION_INTERVAL_S = 0.9;
const MAX_SPEED = 130;
const ACCEL = 9; // km/h per second
const BRAKE = 30;
const EMERGENCY_BRAKE = 40;
const DRAG = 1;
const DANGER_THRESHOLD = 0.55;
const FIXED_STEP_S = 0.05;
const MAX_CATCHUP_S = 2.0;
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
    this.poly = new Polyline(route.points.map(([lon, lat]) => this.proj.toLocal(lon, lat)));
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
        Math.random() < 0.08 ? "truck" : Math.random() < 0.25 ? "taxi" : "car";
      const factor = kind === "truck" ? 0.72 : 0.82 + Math.random() * 0.15;
      const s = this.s + (initial ? 120 + Math.random() * 600 : 320 + Math.random() * 500);
      this.traffic.push({
        id: uid++,
        s,
        dir: 1,
        speedMs: ((limit * factor) / 3.6) as number,
        baseSpeedMs: (limit * factor) / 3.6,
        kind,
        color: ["#8e99a8", "#a86f5c", "#5c7a99", "#7a8c5c", "#99685c", "#c2c7ce"][
          Math.floor(Math.random() * 6)
        ],
        changing: false,
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
    this.crossings.push({
      id: uid++,
      s,
      lateral: -dir * 7,
      from: -dir * 7,
      to: dir * 7,
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

  private pedestrianAhead(): { kind: "persona" | "perro"; distanceM: number } | null {
    let best: CrossingEntity | null = null;
    for (const c of this.crossings) {
      if (c.done) continue;
      const ds = c.s - this.s;
      // only report pedestrians that are actually relevant to the car now —
      // reporting ones 100 m away made Jev brake forever and stall the trip
      if (ds > -2 && ds < 45 && (!best || Math.abs(ds) < Math.abs(best.s - this.s))) best = c;
    }
    return best ? { kind: best.kind, distanceM: Math.round(best.s - this.s) } : null;
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
      ? `${ped.kind} cruzando la calzada`
      : emerg
        ? `Vehículo de emergencia (${emerg.type}) acercándose`
        : veh && veh.distanceM < 40
          ? `Ocupada: ${veh.type} a ${veh.distanceM} m`
          : oncoming && oncoming.distanceM < 40
            ? "Tráfico en sentido contrario cercano"
            : "Despejada";
    return {
      tick: this.tick,
      gps: {
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
      this.status = "error";
      this.accelCmd = "brake";
      this.cb.onError("Jev no respondió a tiempo; reintentando…");
      setTimeout(() => {
        if (this.status === "error") this.status = "running";
      }, 1500);
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
        this.status = "error";
        this.accelCmd = "brake";
        if (this.currentDecision) {
          this.currentDecision.pending = false;
          this.cb.onDecision(this.currentDecision);
        }
        this.cb.onError(err instanceof Error ? err.message : "Error al consultar a Jev");
        setTimeout(() => {
          if (this.status === "error") this.status = "running";
        }, 2500);
      });
  }

  private handleJevResponse(res: DecideResponse, state: PerceptionState) {
    this.pendingDecision = false;
    if (this.status !== "ended") this.status = "running";
    this.decisions++;

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
        this.accelCmd = "brake";
        this.incidents++;
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
    for (const t of this.traffic) {
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
      // clamp accel/decel so braking chains are predictable
      const dv = v - t.speedMs;
      t.speedMs += Math.sign(dv) * Math.min(Math.abs(dv), 7 * dt);
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

    // a much slower vehicle ahead eventually turns off the road so the
    // trip doesn't stall behind a rolling roadblock
    let slowAhead: TrafficCar | null = null;
    for (const t of this.traffic) {
      if (t.dir !== 1) continue;
      const ds = t.s - this.s;
      if (ds > 0.5 && ds < 45 && t.speedMs * 3.6 < limit * 0.55) slowAhead = t;
    }
    if (slowAhead && this.speedKmh < limit * 0.65) {
      this.stuckBehindS += dt;
      if (this.stuckBehindS > 9) {
        this.stuckBehindS = 0;
        this.traffic = this.traffic.filter((t) => t.id !== slowAhead!.id);
      }
    } else {
      this.stuckBehindS = Math.max(0, this.stuckBehindS - dt * 2);
    }

    if (this.emergency) {
      this.speedKmh = Math.max(0, this.speedKmh - EMERGENCY_BRAKE * dt);
    } else if (this.cruiseActive && this.cruiseTargetKmh !== null && this.accelCmd !== "brake") {
      // adaptive cruise: hold target, keep 2-second gap to vehicle ahead
      const target = Math.min(this.cruiseTargetKmh, limit + 10);
      const safeGap = (this.speedKmh / 3.6) * 2 + 6;
      if (veh && gapM < safeGap) {
        this.speedKmh = Math.max(0, this.speedKmh - BRAKE * dt);
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
          // respect a safe following distance even when Jev says go
          const safeGap = (this.speedKmh / 3.6) * 1.8 + 5;
          if (veh && gapM < safeGap) {
            this.speedKmh = Math.max(0, this.speedKmh - BRAKE * dt);
          } else {
            this.speedKmh = Math.min(Math.min(limit + 8, MAX_SPEED), this.speedKmh + ACCEL * dt);
          }
          break;
        }
        case "brake":
          this.speedKmh = Math.max(0, this.speedKmh - BRAKE * dt);
          break;
        case "maintain": {
          // never coast into the vehicle ahead: keep a safe gap and match it
          const safeGap = (this.speedKmh / 3.6) * 1.8 + 5;
          if (veh && gapM < safeGap * 0.75) {
            this.speedKmh = Math.max(0, this.speedKmh - BRAKE * dt);
            break;
          }
          if (veh && gapM < safeGap && leaderV !== null) {
            if (this.speedKmh > leaderV + 1) {
              this.speedKmh = Math.max(leaderV, this.speedKmh - BRAKE * 0.7 * dt);
            } else if (this.speedKmh < leaderV - 3) {
              this.speedKmh = Math.min(leaderV, this.speedKmh + ACCEL * 0.5 * dt);
            }
            break;
          }
          if (this.speedKmh < 6) {
            const ped = this.pedestrianAhead();
            if ((!veh || gapM > 9) && (!ped || ped.distanceM > 12)) {
              // creep forward like a real Tesla in congestion
              this.speedKmh = Math.min(10, this.speedKmh + 6 * dt);
              break;
            }
          }
          this.speedKmh = Math.max(0, this.speedKmh - DRAG * dt);
          break;
        }
      }
    }
    // stuck detector: if we're stopped with nothing in front for a while,
    // Jev's last order can't be trusted — nudge to maintain, then accelerate
    if (this.speedKmh < 0.5) {
      const pedStopped = this.pedestrianAhead();
      if ((!veh || gapM > 12) && (!pedStopped || pedStopped.distanceM > 14)) {
        this.stoppedTime += dt;
        if (this.stoppedTime > 5 && this.accelCmd === "brake") this.accelCmd = "maintain";
        if (this.stoppedTime > 10) this.accelCmd = "accelerate";
      } else {
        this.stoppedTime = 0;
      }
    } else {
      this.stoppedTime = 0;
    }

    const decel = (prevSpeed - this.speedKmh) / Math.max(dt, 0.001);
    if (decel > HARD_BRAKE_INCIDENT && this.lastDecel <= HARD_BRAKE_INCIDENT) {
      this.incidents++;
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

    // rear-end: crash only with a real closing speed; a light tap is an incident
    if (veh && gapM < CAR_LEN_M * 0.55 && this.speedKmh > 10) {
      const closing = leader ? this.speedKmh - leader.speedMs * 3.6 : 99;
      if (closing > 18) {
        return this.crash(`Colisión por alcance con ${veh.type}`);
      }
      // light contact: count an incident and match the leader's speed
      this.incidents++;
      this.score = Math.max(0, this.score - 50);
      this.speedKmh = Math.max(0, leader ? leader.speedMs * 3.6 : 0);
      if (leader) this.s = Math.min(this.s, leader.s - CAR_LEN_M - 0.3);
    }

    this.maybeDecide(dt);
    this.cb.onFrame(this.snapshot());
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
      car: this.poly.atOffset(this.s, LANE),
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
