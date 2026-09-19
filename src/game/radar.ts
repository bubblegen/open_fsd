/**
 * Circular GPS radar (GTA-style) — map ball bottom-right of the 3D view.
 * Rotates with the car heading (car always points up), draws map tiles,
 * the route (traveled dim / upcoming Tesla-blue), the next maneuver, a
 * destination pin and speed + limit inside the dial.
 */
import type { RenderState } from "./engine";
import { TILE_ZOOM, tileImg, globalPx, metersPerPixel } from "./tiles2d";

const SIZE = 300; // css px

export class Radar {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  private lastDraw = 0;

  constructor(private canvas: HTMLCanvasElement) {
    canvas.width = SIZE * this.dpr;
    canvas.height = SIZE * this.dpr;
    canvas.style.width = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    this.ctx = canvas.getContext("2d")!;
  }

  update(rs: RenderState) {
    const now = performance.now();
    if (now - this.lastDraw < 90) return; // ~11 fps is plenty
    this.lastDraw = now;
    this.draw(rs);
  }

  private draw(rs: RenderState) {
    const ctx = this.ctx;
    const R = (SIZE / 2) * this.dpr;
    const cx = R;
    const cy = R;
    const { proj, poly } = rs;
    const mpp = metersPerPixel(proj.lat0, TILE_ZOOM);
    const pxPerM = 1 / mpp;

    const carLL = proj.toLonLat(rs.car.x, rs.car.y);
    const carGp = globalPx(carLL.lon, carLL.lat, TILE_ZOOM);
    const theta = -Math.PI / 2 - rs.car.angle; // rotate so the car faces up

    ctx.clearRect(0, 0, SIZE * this.dpr, SIZE * this.dpr);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#0b0e13";
    ctx.fillRect(0, 0, SIZE * this.dpr, SIZE * this.dpr);

    ctx.translate(cx, cy);
    ctx.rotate(theta);

    // tiles around the car (cover the rotated circle: radius + tile diagonal margin)
    const reach = R + 256 * this.dpr;
    const t0x = Math.floor((carGp.x - reach) / 256);
    const t1x = Math.floor((carGp.x + reach) / 256);
    const t0y = Math.floor((carGp.y - reach) / 256);
    const t1y = Math.floor((carGp.y + reach) / 256);
    for (let tx = t0x; tx <= t1x; tx++) {
      for (let ty = t0y; ty <= t1y; ty++) {
        if (tx < 0 || ty < 0 || tx >= 2 ** TILE_ZOOM || ty >= 2 ** TILE_ZOOM) continue;
        const img = tileImg(TILE_ZOOM, tx, ty);
        const dx = tx * 256 - carGp.x;
        const dy = ty * 256 - carGp.y;
        if (img.complete && img.naturalWidth > 0) {
          ctx.filter =
            "invert(0.92) hue-rotate(185deg) saturate(0.45) brightness(0.75) contrast(1.1)";
          ctx.drawImage(img, dx * this.dpr, dy * this.dpr, 256 * this.dpr, 256 * this.dpr);
          ctx.filter = "none";
        }
      }
    }

    // route polyline
    const drawRoute = (fromS: number, toS: number, style: string, width: number, glow: boolean) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width * this.dpr;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (glow) {
        ctx.shadowColor = style;
        ctx.shadowBlur = 7 * this.dpr;
      }
      ctx.beginPath();
      let started = false;
      const step = 6;
      for (let s = Math.max(0, fromS); s <= Math.min(poly.total, toS); s += step) {
        const p = poly.at(s);
        const dx = (p.x - rs.car.x) * pxPerM * this.dpr;
        const dy = (p.y - rs.car.y) * pxPerM * this.dpr;
        if (!started) {
          ctx.moveTo(dx, dy);
          started = true;
        } else ctx.lineTo(dx, dy);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    drawRoute(0, rs.s, "rgba(70,95,135,0.5)", 2.4, false);
    drawRoute(rs.s, poly.total, "#3d91ff", 3.2, true);

    // destination pin
    const ddx = (rs.dest.x - rs.car.x) * pxPerM * this.dpr;
    const ddy = (rs.dest.y - rs.car.y) * pxPerM * this.dpr;
    ctx.fillStyle = "#34d399";
    ctx.beginPath();
    ctx.arc(ddx, ddy, 5 * this.dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#052e1c";
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.stroke();

    // next maneuver marker
    const man = rs.nextManeuver;
    if (man) {
      const mp = poly.at(man.s);
      const mdx = (mp.x - rs.car.x) * pxPerM * this.dpr;
      const mdy = (mp.y - rs.car.y) * pxPerM * this.dpr;
      ctx.fillStyle = "#3d91ff";
      ctx.beginPath();
      ctx.arc(mdx, mdy, 4.5 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#dbeafe";
      ctx.lineWidth = 1.6 * this.dpr;
      ctx.stroke();
    }

    // car triangle (points up in rotated space)
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.6 * this.dpr;
    ctx.beginPath();
    const cs = 6.5 * this.dpr;
    ctx.moveTo(0, -cs);
    ctx.lineTo(cs * 0.72, cs * 0.85);
    ctx.lineTo(0, cs * 0.4);
    ctx.lineTo(-cs * 0.72, cs * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    // fixed overlay: north letter orbiting with map rotation
    const nDist = R - 16 * this.dpr;
    // direction of map-north (0,-1) after rotating by theta
    const rx = Math.sin(theta);
    const ry = -Math.cos(theta);
    ctx.fillStyle = "rgba(226,232,240,0.9)";
    ctx.font = `bold ${11 * this.dpr}px ui-sans-serif, system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", cx + rx * nDist, cy + ry * nDist);

    // speed (bottom) + limit (top-left) inside the dial
    ctx.fillStyle = "#e2e8f0";
    ctx.font = `bold ${26 * this.dpr}px ui-monospace, monospace`;
    ctx.fillText(`${Math.round(rs.speedKmh)}`, cx, cy + R - 34 * this.dpr);
    ctx.font = `${9 * this.dpr}px ui-sans-serif, system-ui`;
    ctx.fillStyle = "#94a3b8";
    ctx.fillText("km/h", cx, cy + R - 16 * this.dpr);

    // limit badge
    const lbR = 15 * this.dpr;
    const lbx = cx - R + 26 * this.dpr;
    const lby = cy - R + 26 * this.dpr;
    ctx.beginPath();
    ctx.arc(lbx, lby, lbR, 0, Math.PI * 2);
    ctx.fillStyle = "#020617";
    ctx.fill();
    ctx.strokeStyle = "#f8fafc";
    ctx.lineWidth = 3 * this.dpr;
    ctx.stroke();
    ctx.fillStyle = "#f8fafc";
    ctx.font = `bold ${13 * this.dpr}px ui-monospace, monospace`;
    ctx.fillText(`${rs.limit}`, lbx, lby);

    // outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, R - 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(100,116,139,0.8)";
    ctx.lineWidth = 3 * this.dpr;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 6 * this.dpr, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(15,23,42,0.9)";
    ctx.lineWidth = 2 * this.dpr;
    ctx.stroke();
  }

  dispose() {}
}
