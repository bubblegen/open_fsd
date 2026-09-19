import {
  GRID,
  SPACING,
  WORLD,
  ROAD_W,
  CAR_LEN,
  CAR_W,
  type RenderState,
} from "./engine";

const ASPHALT = "#1c1f24";
const BLOCK = "#14161a";
const SIDEWALK = "#26292f";
const LANE = "rgba(255,255,255,0.35)";
const LIMIT_COLORS: Record<number, string> = {
  30: "#e8c34a",
  50: "#5cb3e8",
  70: "#6dd18f",
};

const nodePx = (n: { i: number; j: number }) => ({ x: n.i * SPACING, y: n.j * SPACING });

export function drawScene(ctx: CanvasRenderingContext2D, rs: RenderState) {
  ctx.clearRect(0, 0, WORLD, WORLD);

  drawBlocks(ctx);
  drawRoads(ctx, rs);
  drawDestination(ctx, rs);
  drawPedestrians(ctx, rs);
  drawNpcs(ctx, rs);
  drawTesla(ctx, rs);
  drawSensorOverlay(ctx, rs);
}

function drawBlocks(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = BLOCK;
  ctx.fillRect(0, 0, WORLD, WORLD);
  for (let i = 0; i < GRID - 1; i++) {
    for (let j = 0; j < GRID - 1; j++) {
      const x = i * SPACING + ROAD_W / 2;
      const y = j * SPACING + ROAD_W / 2;
      const w = SPACING - ROAD_W;
      // sidewalk
      ctx.fillStyle = SIDEWALK;
      ctx.fillRect(x, y, w, w);
      // building
      const seed = (i * 31 + j * 17) % 7;
      const pad = 8 + seed;
      ctx.fillStyle = `hsl(${215 + seed * 6}, 12%, ${13 + seed}%)`;
      roundRect(ctx, x + pad, y + pad, w - pad * 2, w - pad * 2, 6);
      ctx.fill();
      // windows
      ctx.fillStyle = "rgba(240,200,90,0.10)";
      const step = 14;
      for (let wx = x + pad + 6; wx < x + w - pad - 8; wx += step) {
        for (let wy = y + pad + 6; wy < y + w - pad - 8; wy += step) {
          if ((wx * 7 + wy * 13) % 5 < 2) ctx.fillRect(wx, wy, 5, 7);
        }
      }
    }
  }
}

function drawRoads(ctx: CanvasRenderingContext2D, rs: RenderState) {
  ctx.strokeStyle = ASPHALT;
  ctx.lineWidth = ROAD_W;
  ctx.lineCap = "butt";
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const a = nodePx({ i, j });
      if (i + 1 < GRID) {
        const b = nodePx({ i: i + 1, j });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (j + 1 < GRID) {
        const b = nodePx({ i, j: j + 1 });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }
  // center dashes
  ctx.strokeStyle = LANE;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 10]);
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const a = nodePx({ i, j });
      if (i + 1 < GRID) {
        const b = nodePx({ i: i + 1, j });
        ctx.beginPath();
        ctx.moveTo(a.x + ROAD_W / 2 - 4, a.y);
        ctx.lineTo(b.x - ROAD_W / 2 + 4, b.y);
        ctx.stroke();
      }
      if (j + 1 < GRID) {
        const b = nodePx({ i, j: j + 1 });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y + ROAD_W / 2 - 4);
        ctx.lineTo(b.x, b.y - ROAD_W / 2 + 4);
        ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);

  // speed-limit chips at edge midpoints
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 10px ui-monospace, monospace";
  for (const [key, limit] of rs.limits) {
    const [aStr, bStr] = key.split("-");
    const [ai, aj] = aStr.split(",").map(Number);
    const [bi, bj] = bStr.split(",").map(Number);
    const a = nodePx({ i: ai, j: aj });
    const b = nodePx({ i: bi, j: bj });
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const vertical = ai === bi;
    const ox = vertical ? ROAD_W / 2 - 8 : 0;
    const oy = vertical ? 0 : ROAD_W / 2 - 8;
    ctx.fillStyle = "rgba(10,12,14,0.85)";
    roundRect(ctx, mx + ox - 11, my + oy - 8, 22, 16, 4);
    ctx.fill();
    ctx.strokeStyle = LIMIT_COLORS[limit] ?? "#888";
    ctx.lineWidth = 1.5;
    roundRect(ctx, mx + ox - 11, my + oy - 8, 22, 16, 4);
    ctx.stroke();
    ctx.fillStyle = LIMIT_COLORS[limit] ?? "#aaa";
    ctx.fillText(String(limit), mx + ox, my + oy);
  }

  // intersections
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const p = nodePx({ i, j });
      ctx.fillStyle = ASPHALT;
      ctx.fillRect(p.x - ROAD_W / 2, p.y - ROAD_W / 2, ROAD_W, ROAD_W);
      // highlight next intersection when a turn is latched and near
      if (
        rs.latchedTurn &&
        rs.latchedTurn !== "straight" &&
        rs.to.i === i &&
        rs.to.j === j &&
        rs.distanceToIntersectionM < 20
      ) {
        ctx.strokeStyle = "rgba(61,145,255,0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(p.x - ROAD_W / 2 - 2, p.y - ROAD_W / 2 - 2, ROAD_W + 4, ROAD_W + 4);
        ctx.setLineDash([]);
      }
    }
  }
}

function drawDestination(ctx: CanvasRenderingContext2D, rs: RenderState) {
  const p = nodePx(rs.destination);
  const pulse = 1 + Math.sin(rs.elapsed * 4) * 0.15;
  ctx.beginPath();
  ctx.arc(p.x, p.y, (ROAD_W / 2 + 4) * pulse, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(109,209,143,0.9)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#6dd18f";
  ctx.fill();
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.fillStyle = "#6dd18f";
  ctx.textAlign = "center";
  ctx.fillText("DESTINO", p.x, p.y - ROAD_W / 2 - 12);
}

function drawPedestrians(ctx: CanvasRenderingContext2D, rs: RenderState) {
  for (const p of rs.peds) {
    const c = nodePx(p.node);
    const x = c.x + (p.axis === "h" ? p.progress * ROAD_W : 0);
    const y = c.y + (p.axis === "v" ? p.progress * ROAD_W : 0);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#f2c94c";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function headingOf(a: { i: number; j: number }, b: { i: number; j: number }) {
  if (b.i > a.i) return "E";
  if (b.i < a.i) return "W";
  if (b.j > a.j) return "S";
  return "N";
}

const DIR_ANGLE: Record<string, number> = { E: 0, S: Math.PI / 2, W: Math.PI, N: -Math.PI / 2 };

function drawNpcs(ctx: CanvasRenderingContext2D, rs: RenderState) {
  for (const n of rs.npcs) {
    const a = nodePx(n.from);
    const b = nodePx(n.to);
    const x = a.x + (b.x - a.x) * n.t;
    const y = a.y + (b.y - a.y) * n.t;
    const h = headingOf(n.from, n.to);
    const d = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[h] as [number, number];
    const off = 7;
    drawCar(ctx, x + d[1] * off, y - d[0] * off, DIR_ANGLE[h], n.color, n.parked);
  }
}

function drawTesla(ctx: CanvasRenderingContext2D, rs: RenderState) {
  const { x, y } = rs.pos;
  const angle = DIR_ANGLE[rs.heading];

  // headlight cone (what it "sees")
  const coneLen = 70 + rs.speedKmh * 1.1;
  const grad = ctx.createRadialGradient(x, y, 10, x, y, coneLen);
  grad.addColorStop(0, "rgba(120,190,255,0.14)");
  grad.addColorStop(1, "rgba(120,190,255,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, coneLen, angle - 0.55, angle + 0.55);
  ctx.closePath();
  ctx.fill();

  const d = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[rs.heading] as [number, number];
  const off = 7;
  const cx = x + d[1] * off;
  const cy = y - d[0] * off;

  // emergency glow
  if (rs.emergency) {
    ctx.beginPath();
    ctx.arc(cx, cy, 20 + Math.sin(rs.elapsed * 14) * 3, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(235,87,87,0.85)";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  drawCar(ctx, cx, cy, angle, rs.crashed ? "#8a3a3a" : "#e8ecf1", false, true);

  // label
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(232,236,241,0.75)";
  ctx.fillText("TESLA", cx, cy - CAR_W);
}

function drawCar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  color: string,
  parked = false,
  isTesla = false,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  roundRect(ctx, -CAR_LEN / 2 + 1.5, -CAR_W / 2 + 2, CAR_LEN, CAR_W, 4);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, -CAR_LEN / 2, -CAR_W / 2, CAR_LEN, CAR_W, 4);
  ctx.fill();
  // windshield
  ctx.fillStyle = "rgba(30,40,55,0.85)";
  roundRect(ctx, CAR_LEN * 0.05, -CAR_W / 2 + 2, CAR_LEN * 0.22, CAR_W - 4, 2);
  ctx.fill();
  // headlights
  ctx.fillStyle = "#fff7cf";
  ctx.fillRect(CAR_LEN / 2 - 2.5, -CAR_W / 2 + 1.5, 2.5, 3);
  ctx.fillRect(CAR_LEN / 2 - 2.5, CAR_W / 2 - 4.5, 2.5, 3);
  // taillights
  ctx.fillStyle = isTesla ? "#ff5a5a" : "#c0392b";
  ctx.fillRect(-CAR_LEN / 2, -CAR_W / 2 + 1.5, 2, 3);
  ctx.fillRect(-CAR_LEN / 2, CAR_W / 2 - 4.5, 2, 3);
  if (parked) {
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    roundRect(ctx, -CAR_LEN / 2, -CAR_W / 2, CAR_LEN, CAR_W, 4);
    ctx.stroke();
  }
  ctx.restore();
}

/** visualizes the perceived obstacles: dashed links + distance labels */
function drawSensorOverlay(ctx: CanvasRenderingContext2D, rs: RenderState) {
  const { x, y } = rs.pos;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center";
  const targets: Array<{ px: number; py: number; label: string; color: string }> = [];

  if (rs.vehicleAhead) {
    const d = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[rs.heading] as [number, number];
    const dist = rs.vehicleAhead.distanceM * 3;
    targets.push({
      px: x + d[0] * dist,
      py: y + d[1] * dist,
      label: `${rs.vehicleAhead.distanceM.toFixed(0)} m · ${rs.vehicleAhead.speedKmh} km/h`,
      color: "#f2994a",
    });
  }
  if (rs.pedestrian) {
    const p = nodePx(rs.to);
    targets.push({
      px: p.x,
      py: p.y,
      label: `peatón a ${rs.pedestrian.distanceM.toFixed(0)} m`,
      color: "#f2c94c",
    });
  }
  if (rs.oncoming && rs.oncoming.distanceM < 40) {
    const d = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[rs.heading] as [number, number];
    targets.push({
      px: x + d[0] * rs.oncoming.distanceM * 3,
      py: y + d[1] * rs.oncoming.distanceM * 3,
      label: `contrario ${rs.oncoming.distanceM.toFixed(0)} m`,
      color: "#eb5757",
    });
  }

  for (const t of targets) {
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(t.px, t.py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = t.color;
    ctx.fillText(t.label, (x + t.px) / 2, (y + t.py) / 2 - 6);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
