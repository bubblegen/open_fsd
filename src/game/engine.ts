import type {
  DecideResponse,
  Direction,
  Heading,
  PerceptionState,
  SpeedAction,
} from "@contracts/ai";

/* ────────────────────────────────────────────────────────────────
   Constants
──────────────────────────────────────────────────────────────── */

export const GRID = 7; // 7x7 intersections → 6x6 blocks
export const SPACING = 118; // px between intersections
export const WORLD = (GRID - 1) * SPACING; // 708 px
export const ROAD_W = 46;
export const PX_PER_M = 3; // 3 px = 1 m
export const EDGE_M = SPACING / PX_PER_M; // ~39.3 m per block
export const CAR_LEN = 26;
export const CAR_W = 14;

const DECISION_INTERVAL_S = 0.9;
const MAX_SPEED = 90; // km/h
const ACCEL = 7; // km/h per second
const BRAKE = 20;
const EMERGENCY_BRAKE = 34;
const DRAG = 0.8;
const DANGER_THRESHOLD = 0.55;
const HARD_BRAKE_INCIDENT = 26; // km/h per second — only true emergency braking counts

/* ────────────────────────────────────────────────────────────────
   Types
──────────────────────────────────────────────────────────────── */

export interface GridNode {
  i: number;
  j: number;
}

export interface NpcCar {
  id: number;
  from: GridNode;
  to: GridNode;
  t: number;
  speedKmh: number; // 0 = parked
  parked: boolean;
  color: string;
  parkedUntil?: number; // engine-time seconds; parked cars leave after a while
}

export interface Pedestrian {
  id: number;
  node: GridNode;
  axis: "h" | "v"; // crossing along x (h) or y (v)
  progress: number; // -1 → 1 across the road
  speed: number;
}

export type GameMode = "autopilot" | "human";
export type EngineStatus = "running" | "thinking" | "error" | "ended";

export interface DecisionLogEntry {
  tick: number;
  speedAction: SpeedAction;
  speedProbs: Record<string, number>;
  direction: Direction;
  danger: number;
  confidence: number;
  latencyMs: number;
  source: "jev" | "human";
  applied: boolean;
}

export interface Snapshot {
  tick: number;
  status: EngineStatus;
  speedKmh: number;
  speedLimitKmh: number;
  heading: Heading;
  distanceToIntersectionM: number;
  score: number;
  distanceM: number;
  destinationsReached: number;
  incidents: number;
  decisions: number;
  destination: GridNode;
  latchedTurn: Direction | null;
  dangerLevel: number;
  autopilot: boolean;
  availableDirections: Direction[];
  destinationHint: Direction;
}

export interface TripResult {
  score: number;
  distanceM: number;
  durationS: number;
  decisions: number;
  incidents: number;
  destinationsReached: number;
  crashed: boolean;
}

export interface EngineCallbacks {
  onFrame: (snap: Snapshot) => void;
  onDecision: (view: DecisionView) => void;
  onLog: (entry: DecisionLogEntry) => void;
  onTripEnd: (result: TripResult) => void;
  onError: (message: string) => void;
  requestDecision: (state: PerceptionState) => Promise<DecideResponse>;
}

export interface DecisionView {
  tick: number;
  perception: PerceptionState;
  rawState: unknown;
  response: DecideResponse | null;
  pending: boolean;
  humanApplied: boolean;
  mode: GameMode;
}

/* ────────────────────────────────────────────────────────────────
   Helpers
──────────────────────────────────────────────────────────────── */

const nodePx = (n: GridNode) => ({ x: n.i * SPACING, y: n.j * SPACING });
const sameNode = (a: GridNode, b: GridNode) => a.i === b.i && a.j === b.j;
const inGrid = (n: GridNode) =>
  n.i >= 0 && n.i < GRID && n.j >= 0 && n.j < GRID;

const DIRS: Record<Heading, { dx: number; dy: number; angle: number }> = {
  E: { dx: 1, dy: 0, angle: 0 },
  W: { dx: -1, dy: 0, angle: 180 },
  S: { dx: 0, dy: 1, angle: 90 },
  N: { dx: 0, dy: -1, angle: 270 },
};

function headingBetween(a: GridNode, b: GridNode): Heading {
  if (b.i > a.i) return "E";
  if (b.i < a.i) return "W";
  if (b.j > a.j) return "S";
  return "N";
}

function turnToHeading(current: Heading, turn: Direction): Heading {
  const angle = DIRS[current].angle;
  const next = turn === "straight" ? angle : turn === "left" ? angle - 90 : angle + 90;
  const norm = ((next % 360) + 360) % 360;
  return (Object.keys(DIRS) as Heading[]).find(
    (h) => DIRS[h].angle === norm,
  )!;
}

function edgeLimits(): Map<string, number> {
  // deterministic pseudo-random speed limit per edge
  const map = new Map<string, number>();
  const limits = [30, 50, 50, 70];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      if (i + 1 < GRID)
        map.set(`${i},${j}-${i + 1},${j}`, limits[(i * 7 + j * 3) % limits.length]);
      if (j + 1 < GRID)
        map.set(`${i},${j}-${i},${j + 1}`, limits[(i * 3 + j * 5 + 1) % limits.length]);
    }
  }
  return map;
}

let uid = 1;

/* ────────────────────────────────────────────────────────────────
   Engine
──────────────────────────────────────────────────────────────── */

export class AutopilotGame {
  private cb: EngineCallbacks;
  private raf = 0;
  private lastTs = 0;
  private elapsed = 0;
  private decisionTimer = 0;
  private pendingDecision = false;

  // Tesla state
  private from: GridNode = { i: 0, j: 3 };
  private to: GridNode = { i: 1, j: 3 };
  private t = 0;
  private heading: Heading = "E";
  private speedKmh = 0;
  private speedLimitKmh = 50;
  private latchedTurn: Direction | null = null;
  private accelCmd: SpeedAction = "maintain";
  private emergency = false;

  // World
  private limits = edgeLimits();
  private npcs: NpcCar[] = [];
  private peds: Pedestrian[] = [];
  private destination: GridNode = { i: 6, j: 1 };
  private npcSpawnTimer = 0;
  private pedSpawnTimer = 0;

  // Stats
  private tick = 0;
  private score = 0;
  private distanceM = 0;
  private destinationsReached = 0;
  private incidents = 0;
  private decisions = 0;
  private lastDecel = 0;
  private crashed = false;
  private startedAt = 0;

  mode: GameMode = "autopilot";
  status: EngineStatus = "running";
  currentDecision: DecisionView | null = null;

  constructor(cb: EngineCallbacks) {
    this.cb = cb;
    this.reset();
  }

  /* ── lifecycle ────────────────────────────────────────────── */

  start() {
    this.startedAt = performance.now();
    this.lastTs = performance.now();
    const loop = (ts: number) => {
      const dt = Math.min((ts - this.lastTs) / 1000, 0.05);
      this.lastTs = ts;
      this.elapsed += dt;
      this.update(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  reset() {
    this.tick = 0;
    this.score = 0;
    this.distanceM = 0;
    this.destinationsReached = 0;
    this.incidents = 0;
    this.decisions = 0;
    this.crashed = false;
    this.emergency = false;
    this.speedKmh = 0;
    this.accelCmd = "maintain";
    this.latchedTurn = null;
    this.npcs = [];
    this.peds = [];
    this.status = "running";
    this.decisionTimer = 0;
    this.pendingDecision = false;

    // random far-apart start & destination
    const rnd = (m: number) => Math.floor(Math.random() * m);
    this.from = { i: rnd(GRID), j: rnd(GRID) };
    this.destination = this.from;
    while (sameNode(this.destination, this.from)) {
      this.destination = { i: rnd(GRID), j: rnd(GRID) };
    }
    this.pickInitialEdge();

    // parked cars
    for (let k = 0; k < 3; k++) this.spawnNpc(true);
    this.currentDecision = null;
  }

  private pickInitialEdge() {
    const opts: GridNode[] = [];
    const { i, j } = this.from;
    if (i + 1 < GRID) opts.push({ i: i + 1, j });
    if (i - 1 >= 0) opts.push({ i: i - 1, j });
    if (j + 1 < GRID) opts.push({ i, j: j + 1 });
    if (j - 1 >= 0) opts.push({ i, j: j - 1 });
    this.to = opts[Math.floor(Math.random() * opts.length)];
    this.t = 0;
    this.heading = headingBetween(this.from, this.to);
    this.speedLimitKmh = this.limitFor(this.from, this.to);
  }

  endTrip() {
    this.status = "ended";
    this.cb.onTripEnd({
      score: Math.round(this.score),
      distanceM: Math.round(this.distanceM),
      durationS: Math.round((performance.now() - this.startedAt) / 1000),
      decisions: this.decisions,
      incidents: this.incidents,
      destinationsReached: this.destinationsReached,
      crashed: this.crashed,
    });
  }

  setMode(mode: GameMode) {
    this.mode = mode;
  }

  /* ── world spawns ─────────────────────────────────────────── */

  private spawnNpc(parked = false, movingDensity = 4) {
    const moving = this.npcs.filter((n) => !n.parked).length;
    if (!parked && moving >= movingDensity + this.destinationsReached) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = { i: Math.floor(Math.random() * GRID), j: Math.floor(Math.random() * GRID) };
      const neighbors: GridNode[] = [];
      if (a.i + 1 < GRID) neighbors.push({ i: a.i + 1, j: a.j });
      if (a.i - 1 >= 0) neighbors.push({ i: a.i - 1, j: a.j });
      if (a.j + 1 < GRID) neighbors.push({ i: a.i, j: a.j + 1 });
      if (a.j - 1 >= 0) neighbors.push({ i: a.i, j: a.j - 1 });
      const b = neighbors[Math.floor(Math.random() * neighbors.length)];
      // keep spawn away from the Tesla
      if (sameNode(a, this.from) || sameNode(b, this.from)) continue;
      const occupied =
        !parked &&
        this.npcs.some(
          (n) =>
            (sameNode(n.from, a) && sameNode(n.to, b)) ||
            (sameNode(n.from, b) && sameNode(n.to, a)),
        );
      if (occupied) continue;
      this.npcs.push({
        id: uid++,
        from: a,
        to: b,
        t: parked ? 0.25 + Math.random() * 0.5 : Math.random() * 0.6,
        speedKmh: parked ? 0 : 22 + Math.random() * 26,
        parked,
        parkedUntil: parked ? this.elapsed + 15 + Math.random() * 15 : undefined,
        color: parked
          ? "#5b6472"
          : ["#8e99a8", "#a86f5c", "#5c7a99", "#7a8c5c", "#99685c"][
              Math.floor(Math.random() * 5)
            ],
      });
      return;
    }
  }

  private spawnPed() {
    if (this.peds.length >= 3) return;
    const node = {
      i: Math.floor(Math.random() * GRID),
      j: Math.floor(Math.random() * GRID),
    };
    if (sameNode(node, this.destination)) return;
    this.peds.push({
      id: uid++,
      node,
      axis: Math.random() < 0.5 ? "h" : "v",
      progress: -1,
      speed: 0.35 + Math.random() * 0.2,
    });
  }

  /* ── geometry helpers ─────────────────────────────────────── */

  get pos() {
    const a = nodePx(this.from);
    const b = nodePx(this.to);
    return { x: a.x + (b.x - a.x) * this.t, y: a.y + (b.y - a.y) * this.t };
  }

  private limitFor(a: GridNode, b: GridNode): number {
    const key = `${a.i},${a.j}-${b.i},${b.j}`;
    const rev = `${b.i},${b.j}-${a.i},${a.j}`;
    return this.limits.get(key) ?? this.limits.get(rev) ?? 50;
  }

  private availableTurns(): Direction[] {
    const out: Direction[] = [];
    for (const turn of ["straight", "left", "right"] as Direction[]) {
      const h = turnToHeading(this.heading, turn);
      const next = {
        i: this.to.i + DIRS[h].dx,
        j: this.to.j + DIRS[h].dy,
      };
      if (inGrid(next)) out.push(turn);
    }
    return out;
  }

  private bestDirectionToDestination(): Direction {
    const avail = this.availableTurns();
    if (avail.length === 0) return "straight";
    let best = avail[0];
    let bestDist = Infinity;
    for (const turn of avail) {
      const h = turnToHeading(this.heading, turn);
      const next = {
        i: this.to.i + DIRS[h].dx,
        j: this.to.j + DIRS[h].dy,
      };
      const d = Math.abs(next.i - this.destination.i) + Math.abs(next.j - this.destination.j);
      if (d < bestDist) {
        bestDist = d;
        best = turn;
      }
    }
    return best;
  }

  /* ── perception ───────────────────────────────────────────── */

  private detectVehicleAhead(): { distanceM: number; speedKmh: number } | null {
    let best: { gapPx: number; speedKmh: number } | null = null;
    for (const n of this.npcs) {
      const sameEdge =
        sameNode(n.from, this.from) &&
        sameNode(n.to, this.to) &&
        headingBetween(n.from, n.to) === this.heading;
      if (!sameEdge) continue; // parked cars on the same edge count as obstacles too
      const gap = (n.t - this.t) * SPACING;
      if (gap > 1 && (!best || gap < best.gapPx)) {
        best = { gapPx: gap, speedKmh: n.speedKmh };
      }
    }
    return best ? { distanceM: best.gapPx / PX_PER_M, speedKmh: best.speedKmh } : null;
  }

  private detectOncoming(): { distanceM: number; speedKmh: number } | null {
    for (const n of this.npcs) {
      const opposite =
        sameNode(n.from, this.to) &&
        sameNode(n.to, this.from) &&
        !n.parked;
      if (!opposite) continue;
      const gapPx = (1 - this.t + (1 - n.t)) * SPACING - SPACING;
      if (gapPx > 2) return { distanceM: gapPx / PX_PER_M, speedKmh: n.speedKmh };
    }
    return null;
  }

  private detectPedestrian(): { distanceM: number } | null {
    for (const p of this.peds) {
      if (!sameNode(p.node, this.to)) continue;
      const distToIntersection = (1 - this.t) * SPACING;
      if (Math.abs(p.progress) < 0.9) {
        return { distanceM: distToIntersection / PX_PER_M };
      }
    }
    return null;
  }

  private buildPerception(): PerceptionState {
    const vehAhead = this.detectVehicleAhead();
    const oncoming = this.detectOncoming();
    const ped = this.detectPedestrian();
    const dx = this.destination.i - this.to.i;
    const dy = this.destination.j - this.to.j;
    const parts: string[] = [];
    if (dy < 0) parts.push(`${-dy} manzana(s) al norte`);
    if (dy > 0) parts.push(`${dy} manzana(s) al sur`);
    if (dx > 0) parts.push(`${dx} manzana(s) al este`);
    if (dx < 0) parts.push(`${-dx} manzana(s) al oeste`);
    return {
      tick: this.tick,
      autopilot: {
        speedKmh: Math.round(this.speedKmh),
        speedLimitKmh: this.speedLimitKmh,
        heading: this.heading,
        distanceToIntersectionM: Math.round(((1 - this.t) * SPACING) / PX_PER_M),
        availableDirections: this.availableTurns(),
        destinationRelative: parts.join(" y ") || "estás en el destino",
        destinationHint: this.bestDirectionToDestination(),
      },
      perception: {
        laneAhead:
          vehAhead && vehAhead.distanceM < 25
            ? "Ocupado por un vehículo"
            : oncoming && oncoming.distanceM < 25
              ? "Vehículo en sentido contrario acercándose"
              : "Despejada",
        vehicleAhead: vehAhead
          ? {
              type: vehAhead.speedKmh === 0 ? "coche aparcado" : "coche en marcha",
              distanceM: Math.round(vehAhead.distanceM),
              speedKmh: Math.round(vehAhead.speedKmh),
            }
          : null,
        oncomingVehicle: oncoming
          ? {
              distanceM: Math.round(oncoming.distanceM),
              speedKmh: Math.round(oncoming.speedKmh),
            }
          : null,
        pedestrian: ped ? { distanceM: ped.distanceM } : null,
      },
    };
  }

  /* ── decision loop ────────────────────────────────────────── */

  private maybeDecide(dt: number) {
    if (this.status === "ended" || this.pendingDecision) return;
    this.decisionTimer += dt;
    if (this.decisionTimer < DECISION_INTERVAL_S) return;
    this.decisionTimer = 0;
    this.tick++;
    this.pendingDecision = true;

    const state = this.buildPerception();
    this.currentDecision = {
      tick: this.tick,
      perception: state,
      rawState: state,
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

    const speedAns = res.answers.speed_action;
    const dirAns = res.answers.next_direction;
    const dangerAns = res.answers.immediate_danger;

    const view: DecisionView = {
      tick: this.tick,
      perception: state,
      rawState: state,
      response: res,
      pending: false,
      humanApplied: false,
      mode: this.mode,
    };
    this.currentDecision = view;
    this.cb.onDecision(view);

    if (this.mode === "autopilot") {
      this.applyJevDecision(speedAns.choice as SpeedAction, dirAns.choice as Direction, dangerAns.noul, "jev");
    }
  }

  private applyJevDecision(
    speed: SpeedAction,
    direction: Direction,
    danger: number,
    source: "jev" | "human",
  ) {
    const avail = this.availableTurns();
    const dir = avail.includes(direction)
      ? direction
      : avail.length > 0
        ? avail[Math.floor(Math.random() * avail.length)]
        : "straight";
    this.latchedTurn = dir;
    this.emergency = danger >= DANGER_THRESHOLD;
    this.accelCmd = this.emergency ? "brake" : speed;

    const view = this.currentDecision;
    const res = view?.response;
    this.cb.onLog({
      tick: this.tick,
      speedAction: speed,
      speedProbs: res?.answers.speed_action.probabilities ?? {},
      direction: dir,
      danger,
      confidence: res?.answers.speed_action.confidence ?? 0,
      latencyMs: res?.latencyMs ?? 0,
      source,
      applied: true,
    });
  }

  /** Human mode: player pressed a control */
  applyHumanDecision(speed: SpeedAction, direction: Direction) {
    if (this.mode !== "human" || !this.currentDecision) return;
    const danger = this.currentDecision.response?.answers.immediate_danger.noul ?? 0;
    this.applyJevDecision(speed, direction, danger, "human");
    this.currentDecision.humanApplied = true;
    this.cb.onDecision(this.currentDecision);
  }

  /* ── physics ──────────────────────────────────────────────── */

  private update(dt: number) {
    if (this.status === "ended") return;

    // spawn world entities
    this.npcSpawnTimer += dt;
    this.pedSpawnTimer += dt;
    if (this.npcSpawnTimer > 3.5) {
      this.npcSpawnTimer = 0;
      this.spawnNpc(false);
    }
    if (this.pedSpawnTimer > 6) {
      this.pedSpawnTimer = 0;
      this.spawnPed();
    }

    // NPC movement
    for (const n of this.npcs) {
      if (n.parked || n.speedKmh <= 0) continue;
      n.t += ((n.speedKmh / 3.6) * PX_PER_M * dt) / SPACING;
      if (n.t >= 1) {
        // continue onto a random valid edge
        const here = n.to;
        const opts: GridNode[] = [];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = { i: here.i + di, j: here.j + dj };
          if (inGrid(nx) && !(nx.i === n.from.i && nx.j === n.from.j)) opts.push(nx);
        }
        if (opts.length === 0) {
          n.from = n.to;
          n.to = { ...n.from };
          n.t = 0;
          continue;
        }
        n.from = here;
        n.to = opts[Math.floor(Math.random() * opts.length)];
        n.t = 0;
      }
    }

    // pedestrians
    for (const p of this.peds) p.progress += p.speed * dt * (p.axis === "h" ? 1 : 1);
    this.peds = this.peds.filter((p) => p.progress < 1.2);

    // parked cars eventually drive away — no permanent deadlocks
    this.npcs = this.npcs.filter(
      (n) => !n.parked || n.parkedUntil === undefined || this.elapsed < n.parkedUntil,
    );

    // Tesla speed
    const prevSpeed = this.speedKmh;
    if (this.emergency) {
      this.speedKmh = Math.max(0, this.speedKmh - EMERGENCY_BRAKE * dt);
    } else {
      switch (this.accelCmd) {
        case "accelerate":
          this.speedKmh = Math.min(
            Math.min(this.speedLimitKmh + 8, MAX_SPEED),
            this.speedKmh + ACCEL * dt,
          );
          break;
        case "brake":
          this.speedKmh = Math.max(0, this.speedKmh - BRAKE * dt);
          break;
        case "maintain":
          // Tesla-like creep: never stay frozen at 0 when the lane is clear
          // (a stopped obstacle can be passed cautiously at walking pace)
          if (this.speedKmh < 6) {
            const blocked = this.detectVehicleAhead();
            const canCreep =
              !blocked ||
              (blocked.speedKmh === 0 && blocked.distanceM > 2) ||
              blocked.distanceM > 9;
            if (canCreep) {
              this.speedKmh = Math.min(10, this.speedKmh + 6 * dt);
              break;
            }
          }
          this.speedKmh = Math.max(0, this.speedKmh - DRAG * dt);
          break;
      }
    }
    const decel = (prevSpeed - this.speedKmh) / Math.max(dt, 0.001);
    if (decel > HARD_BRAKE_INCIDENT && this.lastDecel <= HARD_BRAKE_INCIDENT) {
      this.incidents++;
      this.score = Math.max(0, this.score - 25);
    }
    this.lastDecel = decel;

    // cautious passing: when squeezed behind a STOPPED obstacle, cap at walking pace
    const obstacle = this.detectVehicleAhead();
    if (
      obstacle &&
      obstacle.speedKmh === 0 &&
      obstacle.distanceM * PX_PER_M < 40 &&
      this.speedKmh > 6
    ) {
      this.speedKmh = 6;
    }

    // move
    const pxPerSec = (this.speedKmh / 3.6) * PX_PER_M;
    this.t += (pxPerSec * dt) / SPACING;
    this.distanceM += pxPerSec * dt / PX_PER_M;
    this.score += pxPerSec * dt / PX_PER_M / 10;

    // pedestrian collision check (inside intersection box)
    const pNow = this.pos;
    for (const p of this.peds) {
      if (Math.abs(p.progress) > 0.85) continue;
      const c = nodePx(p.node);
      const pp = {
        x: c.x + (p.axis === "h" ? p.progress * ROAD_W : 0),
        y: c.y + (p.axis === "v" ? p.progress * ROAD_W : 0),
      };
      if (Math.hypot(pp.x - pNow.x, pp.y - pNow.y) < 12 && this.speedKmh > 4) {
        return this.crash();
      }
    }

    // arrival at intersection
    if (this.t >= 1) {
      this.from = this.to;
      // destination reached?
      if (sameNode(this.from, this.destination)) {
        this.destinationsReached++;
        this.score += 1000;
        // pick a new destination far from here
        let next = this.from;
        let guard = 0;
        while (
          (sameNode(next, this.from) ||
            Math.abs(next.i - this.from.i) + Math.abs(next.j - this.from.j) < 3) &&
          guard++ < 40
        ) {
          next = {
            i: Math.floor(Math.random() * GRID),
            j: Math.floor(Math.random() * GRID),
          };
        }
        this.destination = next;
      }
      this.chooseNextEdge();
    }

    // rear-end collision with NPC ahead on same edge (creeping past at ≤10 km/h is safe)
    const veh = this.detectVehicleAhead();
    if (veh && veh.distanceM * PX_PER_M < CAR_LEN * 0.7 && this.speedKmh > 10) {
      return this.crash();
    }
    // if blocked behind a stopped car with zero speed for a long time, nudge:
    // (Jev should brake; if fully stopped behind obstacle, wait — no deadlock since NPCs move)

    this.maybeDecide(dt);
    this.pushFrame();
  }

  private chooseNextEdge() {
    const avail = this.availableTurns();
    let turn = this.latchedTurn;
    if (!turn || !avail.includes(turn)) {
      turn = avail.length > 0 ? avail[Math.floor(Math.random() * avail.length)] : null;
    }
    let nextHeading: Heading;
    if (turn === null) {
      // U-turn
      nextHeading = turnToHeading(this.heading, "straight");
      nextHeading = turnToHeading(nextHeading, "right");
      nextHeading = turnToHeading(nextHeading, "right");
    } else {
      nextHeading = turnToHeading(this.heading, turn);
    }
    const next = { i: this.from.i + DIRS[nextHeading].dx, j: this.from.j + DIRS[nextHeading].dy };
    if (!inGrid(next)) {
      // safety fallback: any available
      for (const t2 of avail) {
        const h2 = turnToHeading(this.heading, t2);
        const n2 = { i: this.from.i + DIRS[h2].dx, j: this.from.j + DIRS[h2].dy };
        if (inGrid(n2)) {
          this.to = n2;
          this.heading = h2;
          this.t = 0;
          this.speedLimitKmh = this.limitFor(this.from, this.to);
          return;
        }
      }
      this.to = { i: this.from.i - DIRS[this.heading].dx, j: this.from.j - DIRS[this.heading].dy };
      this.t = 0;
      return;
    }
    this.to = next;
    this.heading = nextHeading;
    this.t = 0;
    this.speedLimitKmh = this.limitFor(this.from, this.to);
  }

  private crash() {
    this.crashed = true;
    this.incidents++;
    this.speedKmh = 0;
    this.endTrip();
  }

  /* ── frame snapshot & render data ─────────────────────────── */

  private pushFrame() {
    this.cb.onFrame(this.snapshot());
  }

  snapshot(): Snapshot {
    return {
      tick: this.tick,
      status: this.status,
      speedKmh: Math.round(this.speedKmh),
      speedLimitKmh: this.speedLimitKmh,
      heading: this.heading,
      distanceToIntersectionM: Math.round(((1 - this.t) * SPACING) / PX_PER_M),
      score: Math.round(this.score),
      distanceM: Math.round(this.distanceM),
      destinationsReached: this.destinationsReached,
      incidents: this.incidents,
      decisions: this.decisions,
      destination: this.destination,
      latchedTurn: this.latchedTurn,
      dangerLevel: this.emergency ? 1 : 0,
      autopilot: this.mode === "autopilot",
      availableDirections: this.availableTurns(),
      destinationHint: this.bestDirectionToDestination(),
    };
  }

  /** data the canvas renderer needs every frame */
  renderState() {
    return {
      pos: this.pos,
      heading: this.heading,
      speedKmh: this.speedKmh,
      from: this.from,
      to: this.to,
      t: this.t,
      latchedTurn: this.latchedTurn,
      emergency: this.emergency,
      npcs: this.npcs,
      peds: this.peds,
      destination: this.destination,
      limits: this.limits,
      crashed: this.crashed,
      available: this.availableTurns(),
      distanceToIntersectionM: ((1 - this.t) * SPACING) / PX_PER_M,
      vehicleAhead: this.detectVehicleAhead(),
      oncoming: this.detectOncoming(),
      pedestrian: this.detectPedestrian(),
      elapsed: this.elapsed,
    };
  }
}

export type RenderState = ReturnType<AutopilotGame["renderState"]>;
