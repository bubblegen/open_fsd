/**
 * 3D world renderer (Three.js) — GTA-style night chase view.
 * The car drives on a road ribbon built from the real OSRM route; procedural
 * buildings, streetlights, traffic, pedestrians, police/ambulances, the
 * Tesla-style glowing route line and a floating maneuver chevron complete
 * the scene. A circular GPS radar is drawn separately (radar.ts).
 */
import * as THREE from "three";
import type { RenderState } from "./engine";

const ROAD_HALF = 3.6;
const SIDEWALK_OUT = 6.0;

/* deterministic pseudo-random from a seed */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function glowTexture(color: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, color);
  grad.addColorStop(0.4, color.replace("1)", "0.45)"));
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

interface VehicleMesh {
  group: THREE.Group;
  brake: THREE.Mesh;
  lightL: THREE.Sprite;
  lightR: THREE.Sprite;
  police?: { red: THREE.Mesh; blue: THREE.Mesh };
}

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private resizeObs: ResizeObserver;
  private built = false;

  // world groups
  private world = new THREE.Group();
  private ground?: THREE.Mesh;
  private glowWindow?: THREE.Mesh;
  private chevron?: THREE.Group;
  private beacon?: THREE.Group;
  private sensorLines: THREE.Line[] = [];

  // dynamic pools
  private tesla!: VehicleMesh & {
    signals: { l: THREE.Sprite; r: THREE.Sprite };
    ring: THREE.Mesh;
    cones: THREE.Mesh[];
  };
  private vehicles = new Map<number, VehicleMesh>();
  private peds = new Map<number, THREE.Group>();
  private pedPhase = new Map<number, number>();

  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private tmpV = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;

    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 900);
    this.scene.background = new THREE.Color(0x05070d);
    this.scene.fog = new THREE.Fog(0x05070d, 80, 420);

    const hemi = new THREE.HemisphereLight(0x46536e, 0x11141a, 1.7);
    this.scene.add(hemi);
    const moon = new THREE.DirectionalLight(0x9db2d4, 1.0);
    moon.position.set(-80, 120, -60);
    this.scene.add(moon);
    this.scene.add(new THREE.AmbientLight(0x1c2430, 1.4));

    this.scene.add(this.world);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth ?? 800;
    const h = Math.max(360, Math.round(w * 0.56));
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = "100%";
    this.canvas.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ── world construction (once per route) ─────────────────────── */

  build(rs: RenderState) {
    if (this.built) return;
    this.built = true;
    const { poly, steps } = rs;

    // ground plane follows the car
    const groundGeo = new THREE.PlaneGeometry(1400, 1400);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x171a20 });
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.world.add(this.ground);

    this.buildRoad(rs);
    this.buildRouteLines(rs);
    this.buildBuildings(rs);
    this.buildStreetlights(rs);
    this.buildChevron();
    this.buildBeacon(rs);
    this.tesla = this.buildTesla();

    const carPos = this.toWorld(rs.car.x, rs.car.y);
    this.camPos.copy(carPos).add(new THREE.Vector3(0, 8, -12));
    this.camLook.copy(carPos);
  }

  private toWorld(x: number, y: number): THREE.Vector3 {
    return new THREE.Vector3(x, 0, y);
  }

  private samplePath(rs: RenderState, stepM = 3): { x: number; y: number; a: number; s: number }[] {
    const out: { x: number; y: number; a: number; s: number }[] = [];
    for (let s = 0; s <= rs.poly.total + 0.01; s += stepM) {
      const p = rs.poly.at(s);
      out.push({ x: p.x, y: p.y, a: p.angle, s });
    }
    return out;
  }

  private stripGeometry(
    pts: { x: number; y: number; a: number }[],
    offA: number,
    offB: number,
    y: number,
  ): THREE.BufferGeometry {
    const pos: number[] = [];
    for (const p of pts) {
      const nx = Math.cos(p.a + Math.PI / 2);
      const nz = Math.sin(p.a + Math.PI / 2);
      pos.push(p.x + nx * offA, y, p.y + nz * offA);
      pos.push(p.x + nx * offB, y, p.y + nz * offB);
    }
    const idx: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  private buildRoad(rs: RenderState) {
    const pts = this.samplePath(rs, 3);
    const add = (geo: THREE.BufferGeometry, color: number, opts: Partial<THREE.MeshLambertMaterialParameters> = {}) => {
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, ...opts }));
      this.world.add(mesh);
      return mesh;
    };
    // sidewalks then road (road slightly higher to avoid z-fighting)
    add(this.stripGeometry(pts, ROAD_HALF, SIDEWALK_OUT, 0.012), 0x343941);
    add(this.stripGeometry(pts, -SIDEWALK_OUT, -ROAD_HALF, 0.012), 0x343941);
    add(this.stripGeometry(pts, -ROAD_HALF, ROAD_HALF, 0.028), 0x262b33);

    // edge lines
    add(this.stripGeometry(pts, ROAD_HALF - 0.2, ROAD_HALF - 0.05, 0.042), 0x6f7681);
    add(this.stripGeometry(pts, -ROAD_HALF + 0.05, -ROAD_HALF + 0.2, 0.042), 0x6f7681);

    // center dashes
    const dashPos: number[] = [];
    const dashIdx: number[] = [];
    let di = 0;
    for (let s = 4; s < rs.poly.total - 4; s += 7.5) {
      const p = rs.poly.at(s);
      const q = rs.poly.at(s + 3);
      const nx = Math.cos(p.angle + Math.PI / 2);
      const nz = Math.sin(p.angle + Math.PI / 2);
      const w = 0.09;
      dashPos.push(
        p.x + nx * w, 0.045, p.y + nz * w,
        p.x - nx * w, 0.045, p.y - nz * w,
        q.x + nx * w, 0.045, q.y + nz * w,
        q.x - nx * w, 0.045, q.y - nz * w,
      );
      dashIdx.push(di, di + 1, di + 2, di + 1, di + 3, di + 2);
      di += 4;
    }
    const dashGeo = new THREE.BufferGeometry();
    dashGeo.setAttribute("position", new THREE.Float32BufferAttribute(dashPos, 3));
    dashGeo.setIndex(dashIdx);
    add(dashGeo, 0xb9bfc9);

    // crosswalks + cross streets at maneuver points
    const manS = stepsToS(rs);
    for (const s of manS) {
      if (s < 40 || s > rs.poly.total - 30) continue;
      const p = rs.poly.at(s);
      const nx = Math.cos(p.angle + Math.PI / 2);
      const nz = Math.sin(p.angle + Math.PI / 2);
      // zebra stripes (explicit quads aligned to the road frame)
      const fx = Math.cos(p.angle);
      const fz = Math.sin(p.angle);
      for (let k = -3; k <= 3; k++) {
        const cx = p.x + nx * k * 0.98;
        const cz = p.y + nz * k * 0.98;
        const hw = 0.28; // half width along travel dir
        const hl = ROAD_HALF - 0.5; // half length across road
        const corners = [
          [cx - fx * hw - nx * hl, cz - fz * hw - nz * hl],
          [cx + fx * hw - nx * hl, cz + fz * hw - nz * hl],
          [cx - fx * hw + nx * hl, cz - fz * hw + nz * hl],
          [cx + fx * hw + nx * hl, cz + fz * hw + nz * hl],
        ];
        const g = new THREE.BufferGeometry();
        g.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(
            [
              corners[0][0], 0.05, corners[0][1],
              corners[1][0], 0.05, corners[1][1],
              corners[2][0], 0.05, corners[2][1],
              corners[3][0], 0.05, corners[3][1],
            ],
            3,
          ),
        );
        g.setIndex([0, 1, 2, 1, 3, 2]);
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x9aa0aa }));
        this.world.add(m);
      }
      // crossing street stub (explicit quad along the road normal)
      const hl = 23;
      const hw = 3.7;
      const sg = new THREE.BufferGeometry();
      sg.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          [
            p.x - nx * hl - fx * hw, 0.008, p.y - nz * hl - fz * hw,
            p.x + nx * hl - fx * hw, 0.008, p.y + nz * hl - fz * hw,
            p.x - nx * hl + fx * hw, 0.008, p.y - nz * hl + fz * hw,
            p.x + nx * hl + fx * hw, 0.008, p.y + nz * hl + fz * hw,
          ],
          3,
        ),
      );
      sg.setIndex([0, 1, 2, 1, 3, 2]);
      sg.computeVertexNormals();
      const stubM = new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ color: 0x181b20 }));
      this.world.add(stubM);
    }
  }

  private buildRouteLines(rs: RenderState) {
    // full route, dim (static)
    const pts = this.samplePath(rs, 4);
    const full = new THREE.Mesh(
      this.stripGeometry(pts, -0.17, 0.17, 0.06),
      new THREE.MeshBasicMaterial({
        color: 0x1d3f6e,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    this.world.add(full);

    // upcoming window (rebuilt every frame)
    this.glowWindow = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x3d91ff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.world.add(this.glowWindow);

    // sensor dashed lines
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
      const line = new THREE.Line(
        g,
        new THREE.LineDashedMaterial({ color: 0x67e8f9, dashSize: 1.1, gapSize: 0.8, transparent: true, opacity: 0.85 }),
      );
      line.visible = false;
      this.world.add(line);
      this.sensorLines.push(line);
    }
  }

  private buildBuildings(rs: RenderState) {
    const manS = stepsToS(rs);
    const nearMan = (s: number) => manS.some((m) => Math.abs(m - s) < 18);
    const mats: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    const color = new THREE.Color();

    let n = 0;
    for (let s = 18; s < rs.poly.total - 10; s += 15, n++) {
      if (nearMan(s)) continue;
      const p = rs.poly.at(s + hash(n) * 6);
      for (const side of [-1, 1]) {
        const h1 = hash(n * 3.7 + side * 13.1);
        const h2 = hash(n * 7.3 + side * 29.7);
        const h3 = hash(n * 13.9 + side * 7.9);
        if (h3 < 0.18) continue; // gaps for variety
        const depth = 11 + h1 * 9;
        const width = 9 + h2 * 9;
        const height = 7 + h1 * h1 * 34 + h2 * 8;
        const setback = 4.6 + h3 * 5;
        const off = side * (SIDEWALK_OUT + setback + depth / 2);
        const nx = Math.cos(p.angle + Math.PI / 2);
        const nz = Math.sin(p.angle + Math.PI / 2);
        const m = new THREE.Matrix4();
        const rot = new THREE.Matrix4().makeRotationY(-p.angle);
        const scale = new THREE.Matrix4().makeScale(width, height, depth);
        const trans = new THREE.Matrix4().makeTranslation(p.x + nx * off, height / 2, p.y + nz * off);
        m.copy(trans).multiply(rot).multiply(scale);
        mats.push(m);
        const shade = 0.17 + h2 * 0.15;
        color.setRGB(shade * 0.9, shade, shade * 1.25);
        colors.push(color.clone());
      }
    }

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const inst = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => {
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, colors[i]);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.world.add(inst);

    // a few windows-lit buildings (emissive yellow-ish boxes)
    const litCount = Math.min(60, Math.floor(mats.length / 8));
    const lit = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.02, 0.6, 1.02),
      new THREE.MeshBasicMaterial({ color: 0x3a3524 }),
      litCount,
    );
    for (let i = 0; i < litCount; i++) {
      const src = mats[Math.floor(hash(i * 17.3) * mats.length)];
      const m = new THREE.Matrix4().copy(src);
      const pos = new THREE.Vector3(), rq = new THREE.Quaternion(), sc = new THREE.Vector3();
      m.decompose(pos, rq, sc);
      pos.y = sc.y * (0.35 + hash(i * 3.1) * 0.4);
      sc.set(sc.x * 1.001, 0.35, sc.z * 1.001);
      const mm = new THREE.Matrix4().compose(pos, rq, sc);
      lit.setMatrixAt(i, mm);
    }
    this.world.add(lit);
  }

  private buildStreetlights(rs: RenderState) {
    const texWarm = glowTexture("rgba(255,214,150,1)");
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 5.4, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x2c3138 });
    const headGeo = new THREE.SphereGeometry(0.16, 8, 6);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffd696 });
    let count = 0;
    const positions: { x: number; z: number; side: number }[] = [];
    for (let s = 26; s < rs.poly.total - 10; s += 52) {
      const p = rs.poly.at(s);
      const side = count % 2 === 0 ? 1 : -1;
      const nx = Math.cos(p.angle + Math.PI / 2);
      const nz = Math.sin(p.angle + Math.PI / 2);
      positions.push({ x: p.x + nx * side * (SIDEWALK_OUT + 0.4), z: p.y + nz * side * (SIDEWALK_OUT + 0.4), side });
      count++;
    }
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, positions.length);
    const heads = new THREE.InstancedMesh(headGeo, headMat, positions.length);
    positions.forEach((p, i) => {
      poles.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, 2.7, p.z));
      heads.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, 5.4, p.z));
    });
    this.world.add(poles, heads);
    for (const p of positions) {
      const spr = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: texWarm, color: 0xffd9a0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      spr.position.set(p.x, 5.4, p.z);
      spr.scale.set(4.5, 4.5, 1);
      this.world.add(spr);
    }
  }

  private buildChevron() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x3d91ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 2.4), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.6, 4), mat);
    head.rotation.x = Math.PI / 2;
    head.position.z = 1.9;
    g.add(shaft, head);
    g.visible = false;
    this.chevron = g;
    this.world.add(g);
  }

  private buildBeacon(rs: RenderState) {
    const g = new THREE.Group();
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.3, 70, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x2f7dff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    pillar.position.y = 35;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.3, 32),
      new THREE.MeshBasicMaterial({ color: 0x3d91ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    g.add(pillar, ring);
    g.position.copy(this.toWorld(rs.dest.x, rs.dest.y));
    this.beacon = g;
    this.world.add(g);
  }

  /* ── vehicles ────────────────────────────────────────────────── */

  private makeVehicle(kind: string, colorHex: string): VehicleMesh {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(colorHex) });
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x0e1420 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.55, 4.5), bodyMat);
    body.position.y = 0.55;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.5, 2.3), glassMat);
    cabin.position.set(0, 1.02, -0.25);
    g.add(body, cabin);

    if (kind === "truck") {
      body.scale.set(1.25, 1.5, 1.45);
      cabin.position.z = 1.6;
      const cargo = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.1, 4.6), new THREE.MeshLambertMaterial({ color: 0x394049 }));
      cargo.position.set(0, 1.55, -1.4);
      g.add(cargo);
    }
    if (kind === "taxi") {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.2, 0.3), new THREE.MeshBasicMaterial({ color: 0xffd24a }));
      sign.position.set(0, 1.36, -0.2);
      g.add(sign);
    }
    let police: VehicleMesh["police"];
    if (kind === "police") {
      const band = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.3, 2.2), new THREE.MeshLambertMaterial({ color: 0xe8ecf2 }));
      band.position.y = 0.62;
      const barR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.34), new THREE.MeshBasicMaterial({ color: 0xff3131 }));
      const barB = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.34), new THREE.MeshBasicMaterial({ color: 0x2f7dff }));
      barR.position.set(-0.4, 1.36, -0.2);
      barB.position.set(0.4, 1.36, -0.2);
      g.add(band, barR, barB);
      police = { red: barR, blue: barB };
    }
    if (kind === "ambulance") {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.24, 4.4), new THREE.MeshBasicMaterial({ color: 0xd63030 }));
      stripe.position.y = 0.72;
      const barR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.34), new THREE.MeshBasicMaterial({ color: 0xff3131 }));
      const barB = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.34), new THREE.MeshBasicMaterial({ color: 0x2f7dff }));
      barR.position.set(-0.4, 1.5, -0.2);
      barB.position.set(0.4, 1.5, -0.2);
      g.add(stripe, barR, barB);
      police = { red: barR, blue: barB };
    }

    // wheels
    const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 10);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x0c0d10 });
    for (const [wx, wz] of [[-0.85, 1.45], [0.85, 1.45], [-0.85, -1.45], [0.85, -1.45]] as const) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.33, wz);
      g.add(w);
    }

    // brake / tail light bar
    const brake = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.14, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x5a0f12 }),
    );
    brake.position.set(0, 0.72, -2.26);
    g.add(brake);

    // headlights
    const texWhite = glowTexture("rgba(230,240,255,1)");
    const mkLight = (x: number) => {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: texWhite, color: 0xdfe9ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      spr.position.set(x, 0.62, 2.3);
      spr.scale.set(1.1, 1.1, 1);
      g.add(spr);
      return spr;
    };
    const lightL = mkLight(-0.62);
    const lightR = mkLight(0.62);

    // blob shadow
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 5),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    g.add(shadow);

    this.world.add(g);
    return { group: g, brake, lightL, lightR, police };
  }

  private buildTesla() {
    const v = this.makeVehicle("car", "#8a94a6"); // pearl grey so the Tesla reads at night
    // sleeker cabin
    v.group.children[1].scale.set(0.92, 0.8, 1.05);
    // autopilot ring under the car
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.1, 2.75, 40),
      new THREE.MeshBasicMaterial({ color: 0x3d91ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    v.group.add(ring);
    // turn signals
    const texAmber = glowTexture("rgba(255,190,60,1)");
    const mkSig = (x: number) => {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: texAmber, color: 0xffbe3c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      spr.position.set(x, 0.72, 1.9);
      spr.scale.set(1.4, 1.4, 1);
      v.group.add(spr);
      return spr;
    };
    const signals = { l: mkSig(-0.95), r: mkSig(0.95) };
    // headlight cones
    const cones: THREE.Mesh[] = [];
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xbcd6ff, transparent: true, opacity: 0.055, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    for (const x of [-0.62, 0.62]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.6, 20, 12, 1, true), coneMat);
      cone.rotation.x = -Math.PI / 2 - 0.045;
      cone.position.set(x, 0.6, 12.2);
      v.group.add(cone);
      cones.push(cone);
    }
    return { ...v, signals, ring, cones };
  }

  /* ── per-frame update ────────────────────────────────────────── */

  update(rs: RenderState) {
    if (!this.built) this.build(rs);
    const t = rs.elapsed;
    const dt = Math.min(this.clock.getDelta(), 0.1);

    const carP = rs.car;
    const carPos = this.tmpV.set(carP.x, 0, carP.y);
    const fwdX = Math.cos(carP.angle);
    const fwdZ = Math.sin(carP.angle);

    // ground follows the car (snapped to avoid shimmer)
    if (this.ground) {
      this.ground.position.set(Math.round(carP.x / 60) * 60, 0, Math.round(carP.y / 60) * 60);
    }

    // Tesla
    const tes = this.tesla;
    tes.group.position.copy(carPos);
    tes.group.rotation.y = Math.PI / 2 - carP.angle;
    const braking = rs.accelCmd === "brake" || (tes.group.userData.prevS !== undefined && rs.s < tes.group.userData.prevS);
    (tes.brake.material as THREE.MeshBasicMaterial).color.set(braking ? 0xff2d2d : 0x5a0f12);
    tes.group.userData.prevS = rs.s;
    tes.ring.visible = rs.autopilot;
    if (rs.autopilot) {
      (tes.ring.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.14 * Math.sin(t * 3.2);
    }
    // turn signals when approaching a turn
    const man = rs.nextManeuver;
    const blink = Math.sin(t * 9) > 0;
    let want: "l" | "r" | null = null;
    if (man && man.distanceM < 70 && man.distanceM > 3) {
      if (man.modifier === "left" || man.modifier === "slight left") want = "l";
      else if (man.modifier === "right" || man.modifier === "slight right") want = "r";
      else if (man.type === "roundabout" || man.type === "rotary") want = "r";
    }
    tes.signals.l.material.opacity = want === "l" && blink ? 0.95 : 0;
    tes.signals.r.material.opacity = want === "r" && blink ? 0.95 : 0;

    // traffic pool
    const seen = new Set<number>();
    for (const tc of rs.traffic) {
      seen.add(tc.id);
      let v = this.vehicles.get(tc.id);
      if (!v) {
        v = this.makeVehicle(tc.kind, tc.color);
        this.vehicles.set(tc.id, v);
      }
      const laneOff = tc.dir === 1 ? rs.laneOffset : -rs.laneOffset;
      const p = rs.poly.atOffset(tc.s, laneOff);
      v.group.position.set(p.x, 0, p.y);
      v.group.rotation.y = Math.PI / 2 - (tc.dir === 1 ? p.angle : p.angle + Math.PI);
      // oncoming cars face the other way
      const brakingV = tc.speedMs < tc.baseSpeedMs - 0.8;
      (v.brake.material as THREE.MeshBasicMaterial).color.set(brakingV ? 0xff2d2d : 0x5a0f12);
      if (v.police) {
        const phase = Math.floor(t * 6) % 2 === 0;
        v.police.red.visible = phase;
        v.police.blue.visible = !phase;
      }
    }
    for (const [id, v] of this.vehicles) {
      if (!seen.has(id)) {
        this.world.remove(v.group);
        this.vehicles.delete(id);
      }
    }

    // pedestrians / dogs
    const seenC = new Set<number>();
    for (const c of rs.crossings) {
      seenC.add(c.id);
      let p = this.peds.get(c.id);
      if (!p) {
        p = c.kind === "perro" ? makeDog() : makePerson(c.id);
        this.peds.set(c.id, p);
        this.world.add(p);
      }
      const pos = rs.poly.atOffset(c.s, c.lateral);
      p.position.set(pos.x, 0, pos.y);
      const dirSign = Math.sign(c.to - c.from) || 1;
      const faceA = pos.angle + (Math.PI / 2) * dirSign;
      p.rotation.y = Math.PI / 2 - faceA;
      // walk cycle
      const phase = this.pedPhase.get(c.id) ?? 0;
      const speed = c.speed;
      this.pedPhase.set(c.id, phase + dt * speed * 2.2);
      p.userData.animate?.(this.pedPhase.get(c.id)!, speed);
    }
    for (const [id, p] of this.peds) {
      if (!seenC.has(id)) {
        this.world.remove(p);
        this.peds.delete(id);
        this.pedPhase.delete(id);
      }
    }

    // upcoming route glow window
    this.updateGlowWindow(rs, t);

    // maneuver chevron
    if (this.chevron) {
      if (man && man.distanceM > 4 && man.distanceM < 500 && man.type !== "arrive") {
        const mp = rs.poly.at(man.s);
        this.chevron.visible = true;
        this.chevron.position.set(mp.x, 2.4 + Math.sin(t * 2.4) * 0.35, mp.y);
        let rot = 0;
        if (man.modifier === "left" || man.modifier === "slight left") rot = -Math.PI / 2;
        else if (man.modifier === "right" || man.modifier === "slight right") rot = Math.PI / 2;
        else if (man.type === "roundabout" || man.type === "rotary") rot = Math.PI;
        this.chevron.rotation.y = Math.PI / 2 - (mp.angle + rot);
        const sc = 1 + Math.sin(t * 4) * 0.08;
        this.chevron.scale.set(sc, sc, sc);
      } else {
        this.chevron.visible = false;
      }
    }

    // destination beacon pulse
    if (this.beacon) {
      this.beacon.rotation.y = t * 0.5;
    }

    // sensor dashed lines to what the car sees
    const targets: THREE.Vector3[] = [];
    if (rs.vehicleAhead) {
      const lead = rs.poly.atOffset(rs.s + rs.vehicleAhead.distanceM, rs.laneOffset);
      targets.push(new THREE.Vector3(lead.x, 0.9, lead.y));
    }
    if (rs.emergencyVehicle) {
      const ep = rs.poly.atOffset(rs.s + rs.emergencyVehicle.distanceM, -rs.laneOffset);
      targets.push(new THREE.Vector3(ep.x, 1.2, ep.y));
    }
    if (rs.pedestrian) {
      const pp = rs.poly.atOffset(rs.s + rs.pedestrian.distanceM, rs.laneOffset);
      targets.push(new THREE.Vector3(pp.x, 1.0, pp.y));
    }
    for (let i = 0; i < this.sensorLines.length; i++) {
      const line = this.sensorLines[i];
      const tgt = targets[i];
      if (tgt) {
        const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
        pos.setXYZ(0, carP.x, 1.25, carP.y);
        pos.setXYZ(1, tgt.x, tgt.y, tgt.z);
        pos.needsUpdate = true;
        line.computeLineDistances();
        line.visible = true;
      } else {
        line.visible = false;
      }
    }

    // camera: elevated chase looking forward
    const desired = new THREE.Vector3(
      carPos.x - fwdX * 10.5,
      8.2,
      carPos.z - fwdZ * 10.5,
    );
    const look = new THREE.Vector3(
      carPos.x + fwdX * 15,
      1.1,
      carPos.z + fwdZ * 15,
    );
    const k = 1 - Math.exp(-dt * 4.2);
    this.camPos.lerp(desired, k);
    this.camLook.lerp(look, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    this.renderer.render(this.scene, this.camera);
  }

  private updateGlowWindow(rs: RenderState, t: number) {
    if (!this.glowWindow) return;
    const from = rs.s;
    const to = Math.min(rs.poly.total, rs.s + 280);
    const pts: { x: number; y: number; a: number }[] = [];
    for (let s = from; s <= to; s += 3) {
      const p = rs.poly.at(s);
      pts.push({ x: p.x, y: p.y, a: p.angle });
    }
    if (pts.length < 2) {
      this.glowWindow.visible = false;
      return;
    }
    this.glowWindow.visible = true;
    const w = 0.22;
    const pos: number[] = [];
    for (const p of pts) {
      const nx = Math.cos(p.a + Math.PI / 2);
      const nz = Math.sin(p.a + Math.PI / 2);
      pos.push(p.x + nx * w, 0.09, p.y + nz * w, p.x - nx * w, 0.09, p.y - nz * w);
    }
    const idx: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    this.glowWindow.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.glowWindow.geometry = g;
    (this.glowWindow.material as THREE.MeshBasicMaterial).opacity = 0.75 + 0.2 * Math.sin(t * 2.6);
  }

  dispose() {
    this.resizeObs.disconnect();
    this.renderer.dispose();
  }
}

/* ── pedestrians ───────────────────────────────────────────────── */

function makePerson(seed: number): THREE.Group {
  const g = new THREE.Group();
  const jacket = new THREE.Color().setHSL(hash(seed) * 0.9, 0.45, 0.5);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.24), new THREE.MeshLambertMaterial({ color: jacket }));
  torso.position.y = 0.92;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshLambertMaterial({ color: 0xd9b08c }));
  head.position.y = 1.42;
  const legMat = new THREE.MeshLambertMaterial({ color: 0x23262e });
  const legL = new THREE.Group();
  const legR = new THREE.Group();
  const mkLeg = () => new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.6, 0.16), legMat);
  const ll = mkLeg();
  ll.position.y = -0.3;
  legL.add(ll);
  const lr = mkLeg();
  lr.position.y = -0.3;
  legR.add(lr);
  legL.position.set(-0.11, 0.6, 0);
  legR.position.set(0.11, 0.6, 0);
  g.add(torso, head, legL, legR);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.7),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.015;
  g.add(shadow);
  g.userData.animate = (phase: number) => {
    legL.rotation.x = Math.sin(phase) * 0.55;
    legR.rotation.x = -Math.sin(phase) * 0.55;
  };
  return g;
}

function makeDog(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x7a5a38 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.72), mat);
  body.position.y = 0.36;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.28), mat);
  head.position.set(0, 0.52, 0.44);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.3), mat);
  tail.position.set(0, 0.46, -0.45);
  g.add(body, head, tail);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.9),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.015;
  g.add(shadow);
  g.userData.animate = (phase: number) => {
    tail.rotation.y = Math.sin(phase * 2.4) * 0.6;
    body.position.y = 0.36 + Math.abs(Math.sin(phase)) * 0.03;
  };
  return g;
}

/* helpers */
function stepsToS(rs: RenderState): number[] {
  return rs.steps
    .filter((st) => !["arrive", "continue", "new name", "depart"].includes(st.type))
    .map((st) => st.s);
}
