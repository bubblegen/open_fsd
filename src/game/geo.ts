import type { RouteStep } from "@contracts/geo";

/** Local equirectangular projection around the route origin. x=east, y=south (screen-like). */
export interface Projection {
  lat0: number;
  lon0: number;
  mPerDegLat: number;
  mPerDegLon: number;
  toLocal(lon: number, lat: number): { x: number; y: number };
  toLonLat(x: number, y: number): { lon: number; lat: number };
}

export function createProjection(lon0: number, lat0: number): Projection {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    lat0,
    lon0,
    mPerDegLat,
    mPerDegLon,
    toLocal(lon, lat) {
      return { x: (lon - lon0) * mPerDegLon, y: (lat0 - lat) * mPerDegLat };
    },
    toLonLat(x, y) {
      return { lon: lon0 + x / mPerDegLon, lat: lat0 - y / mPerDegLat };
    },
  };
}

export interface PathPoint {
  x: number;
  y: number;
}

/**
 * Return a copy of `src` with sharp corners replaced by quadratic-bezier
 * arcs, so the driven path and the painted trajectory curve smoothly through
 * turns instead of snapping at every OSRM geometry vertex.
 */
export function roundedPolyline(src: Polyline, radius = 7): Polyline {
  const P = src.pts;
  if (P.length < 3) return src;
  const out: PathPoint[] = [P[0]];
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1];
    const b = P[i];
    const c = P[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const bcx = c.x - b.x;
    const bcy = c.y - b.y;
    const lab = Math.hypot(abx, aby);
    const lbc = Math.hypot(bcx, bcy);
    if (lab < 0.5 || lbc < 0.5) continue; // degenerate, drop
    const dot = (abx * bcx + aby * bcy) / (lab * lbc);
    if (dot > 0.978) {
      // nearly straight (<~12°): keep the vertex as-is
      out.push(b);
      continue;
    }
    const r = Math.min(radius, lab * 0.35, lbc * 0.35);
    const u1x = abx / lab;
    const u1y = aby / lab;
    const u2x = bcx / lbc;
    const u2y = bcy / lbc;
    const p1 = { x: b.x - u1x * r, y: b.y - u1y * r };
    const p2 = { x: b.x + u2x * r, y: b.y + u2y * r };
    out.push(p1);
    const STEPS = 6;
    for (let k = 1; k <= STEPS; k++) {
      const t = k / (STEPS + 1);
      const mt = 1 - t;
      out.push({
        x: mt * mt * p1.x + 2 * mt * t * b.x + t * t * p2.x,
        y: mt * mt * p1.y + 2 * mt * t * b.y + t * t * p2.y,
      });
    }
    out.push(p2);
  }
  out.push(P[P.length - 1]);
  return new Polyline(out);
}

/** Arc-length parameterized polyline with interpolation. */
export class Polyline {
  pts: PathPoint[];
  cum: number[]; // cumulative length at each point
  total: number;

  constructor(pts: PathPoint[]) {
    // dedupe consecutive points
    this.pts = pts.filter(
      (p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.01,
    );
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      this.cum.push(
        this.cum[i - 1] + Math.hypot(this.pts[i].x - this.pts[i - 1].x, this.pts[i].y - this.pts[i - 1].y),
      );
    }
    this.total = this.cum[this.cum.length - 1] ?? 0;
  }

  /** clamp s to [0, total] */
  at(s: number): { x: number; y: number; angle: number } {
    const t = Math.max(0, Math.min(this.total, s));
    // binary search
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= t) lo = mid;
      else hi = mid;
    }
    const a = this.pts[lo];
    const b = this.pts[Math.min(lo + 1, this.pts.length - 1)];
    const segLen = this.cum[lo + 1] - this.cum[lo] || 1;
    const f = (t - this.cum[lo]) / segLen;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  /** point at arc length s, offset to the right of travel direction */
  atOffset(s: number, offset: number): { x: number; y: number; angle: number } {
    const p = this.at(s);
    return {
      x: p.x + Math.cos(p.angle + Math.PI / 2) * offset,
      y: p.y + Math.sin(p.angle + Math.PI / 2) * offset,
      angle: p.angle,
    };
  }

  /** project a lon/lat-derived point onto the path → arc length */
  project(x: number, y: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i];
      const b = this.pts[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const len2 = abx * abx + aby * aby || 1;
      let f = ((x - a.x) * abx + (y - a.y) * aby) / len2;
      f = Math.max(0, Math.min(1, f));
      const px = a.x + abx * f;
      const py = a.y + aby * f;
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < bestD) {
        bestD = d;
        best = this.cum[i] + Math.sqrt(len2) * f;
      }
    }
    return best;
  }
}

/** attach an arc-length position to each route step's maneuver location */
export function stepsWithS(poly: Polyline, proj: Projection, steps: RouteStep[]) {
  return steps.map((st, i) => {
    const p = proj.toLocal(st.lon, st.lat);
    return { ...st, s: Math.max(0, Math.min(poly.total, poly.project(p.x, p.y))), index: i };
  });
}

export type StepWithS = RouteStep & { s: number; index: number };

/** half-width of the paved road (m) for a step, from its limit + class.
 *  30-zone narrow street 6.6 m … motorway 14 m so the Tesla (1.85 m wide)
 *  always sits in a believable lane with curb margin. */
export function roadHalfWidthForStep(st: RouteStep, index: number): number {
  const limit = limitForStep(st, index);
  const t = `${st.name ?? ""} ${(st as { ref?: string }).ref ?? ""}`.toLowerCase();
  if (limit >= 100) return 7.0; // motorway carriageway 14 m
  if (limit >= 80) return 6.2; // arterial / nacional 12.4 m
  if (/paseo|avenida|avda|av\.|boulevard|bulevar|diagonal|gran v[ií]a/.test(t)) return 5.4; // avenue ~10.8 m
  if (limit >= 50) return 4.2; // urban street 8.4 m
  if (limit >= 40) return 3.7; // 7.4 m
  return 3.3; // narrow 30-zone street 6.6 m
}

/** smoothed road half-width at arc position s: blends over ~24 m into a
 *  segment whose class changes so the curb never jumps at step boundaries */
export function roadHalfAt(steps: StepWithS[], s: number): number {
  if (steps.length === 0) return 4.2;
  let cur = steps[0];
  let next: StepWithS | null = null;
  for (const st of steps) {
    if (st.s <= s) cur = st;
    else {
      next = st;
      break;
    }
  }
  const curHalf = roadHalfWidthForStep(cur, cur.index);
  if (!next) return curHalf;
  const nextHalf = roadHalfWidthForStep(next, next.index);
  if (nextHalf === curHalf) return curHalf;
  const f = Math.min(1, Math.max(0, (s - (next.s - 24)) / 24));
  const sm = f * f * (3 - 2 * f);
  return curHalf + (nextHalf - curHalf) * sm;
}

/** legal-ish speed limit heuristic from the road name/ref + step length */
export function limitForStep(st: RouteStep, index: number): number {
  const t = `${st.name} ${(st as { ref?: string }).ref ?? ""}`.toLowerCase();
  if (/autopista|autov[ií]a|motorway|bypass|\bap[- ]?\d|\ba[- ]?\d{1,3}\b|\bv[aá]\b|\bM[- ]?30\b|\bM[- ]?40\b|\bM[- ]?45\b/.test(t))
    return 120;
  if (/n[- ]?\d{1,3}\b|nacional|carretera|trunk/.test(t)) return 90;
  // small deterministic variation by step index for realism
  const jitter = [0, 10, 0, -10][index % 4];
  if (/paseo|avenida|avda|av\.|boulevard|bulevar|diagonal|gran v[ií]a/.test(t))
    return Math.max(50, (st.distanceM > 600 ? 70 : 50) + jitter);
  if (st.distanceM < 120) return 30;
  if (st.distanceM < 400) return 40 + Math.max(0, jitter);
  return 50 + jitter;
}

/** human-readable instruction for a step maneuver */
export function instructionFor(st: RouteStep): string {
  const where = st.name ? (st.type === "arrive" ? "" : ` hacia ${st.name}`) : "";
  const whereInto = st.name && st.type === "arrive" ? ` en ${st.name}` : "";
  switch (st.type) {
    case "depart":
      return `Sal con dirección a ${st.name || "la ruta"}`;
    case "arrive":
      return `Llegarás a tu destino${whereInto}`;
    case "roundabout":
    case "rotary":
      return `Entra en la rotonda y toma la salida ${st.exit ?? 1}${where}`;
    case "exit roundabout":
    case "exit rotary":
      return `Toma la salida ${st.exit ?? 1} de la rotonda${where}`;
    case "merge":
      return `Incorpórate${where}`;
    case "fork":
      return `Mantente a la ${st.modifier === "left" ? "izquierda" : "derecha"}${where}`;
    case "on ramp":
      return `Toma el ramal de entrada${where}`;
    case "off ramp":
      return `Toma la salida${where}`;
    case "new name":
    case "continue":
      return `Continúa por ${st.name || "la misma vía"}`;
    case "turn":
    default: {
      const m = {
        left: "Gira a la izquierda",
        right: "Gira a la derecha",
        straight: "Sigue recto",
        "slight left": "Ligero giro a la izquierda",
        "slight right": "Ligero giro a la derecha",
        "sharp left": "Giro cerrado a la izquierda",
        "sharp right": "Giro cerrado a la derecha",
        uturn: "Giro en U",
      }[st.modifier] ?? "Sigue la ruta";
      return `${m}${where}`;
    }
  }
}
