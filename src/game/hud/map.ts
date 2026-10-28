// The map computer (M / Tab): IGI's satellite map. A top-down orthographic render of the level (terrain and
// buildings) with Jones, enemy soldiers and objective markers drawn over it using computer/computer.res sprites,
// plus Objectives and Log pages. The game keeps running behind it, as in IGI: only the player is frozen.
import * as THREE from "three";
import { METRE, type Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";
import type { Sprite, UiAssets, UiFont } from "./gfx.ts";

const COMPUTER = "computer/computer.res";
const STRINGS = "language/english/computer.res";
const GREEN = "#7dff6a";
const DIM = "#3f8a37";
const PANEL = "rgba(4,16,6,0.92)";
/** Render-target size for the satellite image. */
const IMAGE = 1024;
const TABS = ["MAP", "OBJECTIVES", "LOG"] as const;
type Tab = (typeof TABS)[number];

interface View {
  /** World X/Y (IGI units) at the centre of the map viewport. */
  x: number;
  y: number;
  /** Metres per screen pixel (CSS pixels). */
  scale: number;
}

interface Snapshot {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  /** World span covered by the image (IGI units). */
  span: number;
}

export class MapComputer {
  open = false;
  private game: Game;
  private assets: UiAssets;
  private root = document.createElement("div");
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private sprites = new Map<string, Sprite | null>();
  private font!: UiFont;
  private small!: UiFont;
  private labels = new Map<string, string>();
  private tab: Tab = "MAP";
  private view: View = { x: 0, y: 0, scale: 1 };
  private snapshot: Snapshot | null = null;
  private wantSnapshot = false;
  private bootTime = 0;
  private entries: string[] = [];
  private drag: { x: number; y: number; vx: number; vy: number } | null = null;
  private mouse = { x: -1, y: -1 };
  private hotspots: { x: number; y: number; w: number; h: number; run: () => void }[] = [];
  private target: THREE.WebGLRenderTarget | null = null;
  private cleanup: (() => void)[] = [];

  constructor(game: Game, assets: UiAssets) {
    this.game = game;
    this.assets = assets;
    this.root.style.cssText = "position:absolute;inset:0;display:none;pointer-events:auto;cursor:crosshair;background:#000";
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    this.root.append(this.canvas);
    game.overlay.append(this.root);
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      this.canvas.addEventListener(type, fn as EventListener, { passive: false });
      this.cleanup.push(() => this.canvas.removeEventListener(type, fn as EventListener));
    };
    on("pointerdown", (e) => {
      const hit = this.hotspots.find((h) => e.offsetX >= h.x && e.offsetX < h.x + h.w && e.offsetY >= h.y && e.offsetY < h.y + h.h);
      if (hit) return hit.run();
      this.drag = { x: e.offsetX, y: e.offsetY, vx: this.view.x, vy: this.view.y };
      this.canvas.setPointerCapture(e.pointerId);
    });
    on("pointermove", (e) => {
      this.mouse = { x: e.offsetX, y: e.offsetY };
      if (!this.drag) return;
      const k = this.view.scale * METRE;
      this.view.x = this.drag.vx - (e.offsetX - this.drag.x) * k;
      this.view.y = this.drag.vy + (e.offsetY - this.drag.y) * k;
    });
    on("pointerup", () => (this.drag = null));
    on("wheel", (e) => {
      e.preventDefault();
      this.zoomAt(e.deltaY > 0 ? 1.25 : 0.8, e.offsetX, e.offsetY);
    });
    on("contextmenu", (e) => e.preventDefault());
  }

  async load() {
    await this.assets.preload(COMPUTER);
    const names = ["h_player", "h_guard", "h_camera", "h_computer", "objective_1", "objective_2", "arrowup_1", "arrowup_3", "arrowdown_1", "arrowdown_3", "minus_1", "minus_3", "pointer",
      ...Array.from({ length: 10 }, (_, i) => `h_${i}`)];
    await Promise.all(names.map(async (n) => this.sprites.set(n, await this.assets.sprite(COMPUTER, `${n}.spr`))));
    [this.font, this.small] = await Promise.all([this.assets.font(COMPUTER, "font4.fnt", 12), this.assets.font(COMPUTER, "font3.fnt", 9)]);
    this.labels = await this.assets.strings(STRINGS);
  }

  /** Remember a message for the Log page. */
  log(text: string) {
    const t = Math.floor(this.game.time);
    const stamp = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    this.entries.push(`${stamp}  ${text}`);
    if (this.entries.length > 200) this.entries.shift();
  }

  show() {
    this.open = true;
    this.root.style.display = "block";
    const p = this.game.services.player?.entity.position ?? this.game.origin;
    this.view = { x: p[0], y: p[1], scale: 1.5 };
    this.bootTime = 0;
    this.tab = "MAP";
    this.wantSnapshot = true;
  }

  hide() {
    this.open = false;
    this.root.style.display = "none";
    this.drag = null;
  }

  private zoomAt(factor: number, sx?: number, sy?: number) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const mapRect = this.mapRect(w, h);
    const px = sx ?? mapRect.x + mapRect.w / 2;
    const py = sy ?? mapRect.y + mapRect.h / 2;
    // Keep the world point under the cursor fixed while zooming.
    const before = this.toWorld(px, py, mapRect);
    this.view.scale = Math.max(0.1, Math.min(20, this.view.scale * factor));
    const after = this.toWorld(px, py, mapRect);
    this.view.x += before[0] - after[0];
    this.view.y += before[1] - after[1];
  }

  private mapRect(w: number, h: number) {
    return { x: 16, y: 56, w: w - 32 - 190, h: h - 56 - 40 };
  }

  private toScreen(p: Vec3 | [number, number], r: { x: number; y: number; w: number; h: number }) {
    const k = this.view.scale * METRE;
    return [r.x + r.w / 2 + (p[0] - this.view.x) / k, r.y + r.h / 2 - (p[1] - this.view.y) / k];
  }

  private toWorld(sx: number, sy: number, r: { x: number; y: number; w: number; h: number }): [number, number] {
    const k = this.view.scale * METRE;
    return [this.view.x + (sx - r.x - r.w / 2) * k, this.view.y - (sy - r.y - r.h / 2) * k];
  }

  frame(dt: number) {
    if (!this.open) return;
    this.bootTime += dt;
    const keys = this.game.input;
    // Keyboard panning and zooming (the movement keys pan, as the arrow buttons do).
    const pan = 300 * dt * this.view.scale * METRE;
    if (keys.isDown("forward")) this.view.y += pan;
    if (keys.isDown("back")) this.view.y -= pan;
    if (keys.isDown("left")) this.view.x -= pan;
    if (keys.isDown("right")) this.view.x += pan;

    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = "#020803";
    ctx.fillRect(0, 0, w, h);
    this.hotspots = [];

    const r = this.mapRect(w, h);
    this.drawFrame(w, h, r);
    if (this.tab === "MAP") this.drawMap(r);
    else if (this.tab === "OBJECTIVES") this.drawObjectives(r);
    else this.drawLog(r);
    this.drawSide(w, h, r);
    this.drawBoot(r);
  }

  private drawFrame(w: number, h: number, r: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx;
    // Title strip with page tabs.
    ctx.fillStyle = PANEL;
    ctx.fillRect(0, 0, w, 46);
    ctx.strokeStyle = DIM;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 46.5, w - 1, 0);
    let x = 16;
    for (const t of TABS) {
      const label = (this.labels.get(t) ?? t).toUpperCase();
      const tw = this.font.measure(label) + 24;
      const active = t === this.tab;
      ctx.fillStyle = active ? "rgba(125,255,106,0.18)" : "rgba(125,255,106,0.04)";
      ctx.fillRect(x, 12, tw, 28);
      ctx.strokeStyle = active ? GREEN : DIM;
      ctx.strokeRect(x + 0.5, 12.5, tw - 1, 27);
      this.font.draw(ctx, label, x + tw / 2, 26 - this.font.lineHeight / 2, { color: active ? GREEN : DIM, align: "center" });
      this.hotspots.push({ x, y: 12, w: tw, h: 28, run: () => (this.tab = t) });
      x += tw + 8;
    }
    const title = this.game.services.mission?.title || this.game.level.name.toUpperCase();
    this.font.draw(ctx, title, w - 16, 26 - this.font.lineHeight / 2, { color: GREEN, align: "right" });
    ctx.strokeStyle = DIM;
    ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
    this.small.draw(ctx, "M / TAB / ESC: EXIT    DRAG, WASD: PAN    WHEEL: ZOOM", 16, h - 26, { color: DIM });
  }

  private drawSide(w: number, _h: number, r: { x: number; y: number; w: number; h: number }) {
    if (this.tab !== "MAP") return;
    const ctx = this.ctx;
    const x = w - 190;
    let y = r.y;
    ctx.fillStyle = PANEL;
    ctx.fillRect(x, y, 174, r.h);
    ctx.strokeStyle = DIM;
    ctx.strokeRect(x + 0.5, y + 0.5, 173, r.h - 1);
    y += 10;
    const button = (name: string, label: string, run: () => void) => {
      const hover = this.mouse.x >= x + 10 && this.mouse.x < x + 44 && this.mouse.y >= y && this.mouse.y < y + 34;
      const s = this.sprites.get(`${name}_${hover ? 3 : 1}`) ?? null;
      if (s) ctx.drawImage(s.frames[0], x + 10, y, 34, 34);
      else {
        ctx.strokeStyle = hover ? GREEN : DIM;
        ctx.strokeRect(x + 10.5, y + 0.5, 33, 33);
      }
      this.font.draw(ctx, label, x + 54, y + 17 - this.font.lineHeight / 2, { color: hover ? GREEN : DIM });
      this.hotspots.push({ x: x + 10, y, w: 160, h: 34, run });
      y += 42;
    };
    button("arrowup", "ZOOM IN", () => this.zoomAt(0.7));
    button("arrowdown", "ZOOM OUT", () => this.zoomAt(1.4));
    button("minus", "CENTRE", () => {
      const p = this.game.services.player?.entity.position;
      if (p) [this.view.x, this.view.y] = [p[0], p[1]];
    });
    y += 8;
    const legend: [string, string][] = [["h_player", "JONES"], ["", "ENEMY"], ["h_1", "OBJECTIVE"]];
    for (const [sprite, label] of legend) {
      const s = this.sprites.get(sprite);
      if (s) ctx.drawImage(s.frames[0], x + 27 - (12 * s.width) / s.height / 2, y, (12 * s.width) / s.height, 12);
      else {
        ctx.fillStyle = "#ff3a2a";
        ctx.beginPath();
        ctx.arc(x + 27, y + 6, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      this.small.draw(ctx, label, x + 46, y + 4, { color: GREEN });
      y += 26;
    }
    y += 10;
    const [mx, my] = this.mouse.x >= r.x && this.mouse.x < r.x + r.w && this.mouse.y >= r.y && this.mouse.y < r.y + r.h ? this.toWorld(this.mouse.x, this.mouse.y, r) : [this.view.x, this.view.y];
    this.small.draw(ctx, `X ${Math.round(mx / METRE)}m`, x + 14, y, { color: DIM });
    this.small.draw(ctx, `Y ${Math.round(my / METRE)}m`, x + 14, y + 14, { color: DIM });
    this.small.draw(ctx, `SCALE ${(this.view.scale * 100).toFixed(0)}m / 100px`, x + 14, y + 28, { color: DIM });
  }

  private drawMap(r: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx;
    this.ensureSnapshot(r);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    const snap = this.snapshot;
    if (snap) {
      const [x0, y0] = this.toScreen([snap.x - snap.span / 2, snap.y + snap.span / 2], r);
      const size = snap.span / (this.view.scale * METRE);
      ctx.drawImage(snap.canvas, x0, y0, size, size);
      // Phosphor tint like IGI's satellite screen.
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "#a8ffa0";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalCompositeOperation = "source-over";
    }
    this.drawGrid(r);
    this.drawMarkers(r);
    // Scanlines.
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    for (let y = r.y; y < r.y + r.h; y += 3) ctx.fillRect(r.x, y, r.w, 1);
    ctx.restore();
  }

  private drawGrid(r: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx;
    // 100 m grid (or coarser when zoomed out).
    let step = 100 * METRE;
    while (step / (this.view.scale * METRE) < 40) step *= 2;
    const [wx0, wy1] = this.toWorld(r.x, r.y, r);
    const [wx1, wy0] = this.toWorld(r.x + r.w, r.y + r.h, r);
    ctx.strokeStyle = "rgba(125,255,106,0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = Math.ceil(wx0 / step) * step; gx < wx1; gx += step) {
      const [sx] = this.toScreen([gx, 0], r);
      ctx.moveTo(Math.round(sx) + 0.5, r.y);
      ctx.lineTo(Math.round(sx) + 0.5, r.y + r.h);
    }
    for (let gy = Math.ceil(wy0 / step) * step; gy < wy1; gy += step) {
      const [, sy] = this.toScreen([0, gy], r);
      ctx.moveTo(r.x, Math.round(sy) + 0.5);
      ctx.lineTo(r.x + r.w, Math.round(sy) + 0.5);
    }
    ctx.stroke();
  }

  private drawMarkers(r: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx;
    const blink = Math.floor(this.bootTime * 3) % 2 === 0;
    const icon = (name: string, p: Vec3, size: number, angle = 0) => {
      const s = this.sprites.get(name);
      const [sx, sy] = this.toScreen(p, r);
      if (sx < r.x - size || sy < r.y - size || sx > r.x + r.w + size || sy > r.y + r.h + size) return;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      if (s) ctx.drawImage(s.frames[0], -size / 2, -size / 2, size, size * (s.height / s.width));
      else {
        ctx.fillStyle = GREEN;
        ctx.fillRect(-3, -3, 6, 6);
      }
      ctx.restore();
    };
    // Enemies: every living soldier as a red dot, as IGI's map computer tracks them in real time.
    for (const e of this.game.entities.all()) {
      if (!e.alive || e.kind !== "soldier") continue;
      const [sx, sy] = this.toScreen(e.position, r);
      ctx.fillStyle = "#ff3a2a";
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Objectives with a known position (MissionService objectives may carry one).
    const objectives = this.game.services.mission?.objectives() ?? [];
    objectives.forEach((o, i) => {
      const at = (o as { position?: Vec3 }).position;
      if (at && o.state === "active" && (blink || this.bootTime < 1)) icon(`h_${(i + 1) % 10}`, at, 16);
    });
    const player = this.game.services.player;
    if (player) {
      // h_player points up; the yaw is counter-clockwise about Z, the canvas rotates clockwise.
      icon("h_player", player.entity.position, 16, -player.yaw);
      const [sx, sy] = this.toScreen(player.entity.position, r);
      ctx.strokeStyle = "rgba(125,255,106,0.5)";
      ctx.beginPath();
      ctx.arc(sx, sy, 14 + (this.bootTime * 20) % 16, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawObjectives(r: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx;
    ctx.fillStyle = PANEL;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const mission = this.game.services.mission;
    let y = r.y + 20;
    const x = r.x + 24;
    if (mission?.title) {
      this.font.draw(ctx, mission.title, x, y, { color: GREEN });
      y += this.font.lineHeight + 10;
    }
    const objectives = mission?.objectives() ?? [];
    if (!objectives.length) this.font.draw(ctx, "NO OBJECTIVES RECEIVED", x, y, { color: DIM });
    objectives.forEach((o, i) => {
      const done = o.state === "completed";
      const s = this.sprites.get(done ? "objective_2" : "objective_1");
      if (s) ctx.drawImage(s.frames[0], x, y - 4, 22, 22);
      const color = o.state === "failed" ? "#ff5a4a" : done ? DIM : GREEN;
      const lines = this.font.wrap(`${i + 1}. ${o.text}${o.state === "failed" ? "  (FAILED)" : ""}`, r.w - 90);
      for (const line of lines) {
        this.font.draw(ctx, line, x + 32, y, { color });
        y += this.font.lineHeight;
      }
      y += 10;
    });
    if (mission?.briefing) {
      y += 10;
      for (const line of this.small.wrap(mission.briefing, (r.w - 60) / 1)) {
        if (y > r.y + r.h - 20) break;
        this.small.draw(ctx, line, x, y, { color: DIM });
        y += this.small.lineHeight + 1;
      }
    }
  }

  private drawLog(r: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx;
    ctx.fillStyle = PANEL;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const lines = this.entries.flatMap((e) => this.font.wrap(e, r.w - 48));
    const fit = Math.floor((r.h - 40) / this.font.lineHeight);
    let y = r.y + 20;
    if (!lines.length) this.font.draw(ctx, "LOG EMPTY", r.x + 24, y, { color: DIM });
    for (const line of lines.slice(-fit)) {
      this.font.draw(ctx, line, r.x + 24, y, { color: GREEN });
      y += this.font.lineHeight;
    }
  }

  /** IGI's map boots with INITIALIZING / CONNECTING / DOWNLOADING before the picture scans in. */
  private drawBoot(r: { x: number; y: number; w: number; h: number }) {
    const t = this.bootTime;
    if (t > 1.6 || this.tab !== "MAP") return;
    const ctx = this.ctx;
    const reveal = Math.max(0, (t - 0.8) / 0.8);
    ctx.fillStyle = "#020803";
    ctx.fillRect(r.x, r.y + r.h * reveal, r.w, r.h * (1 - reveal));
    if (reveal > 0 && reveal < 1) {
      ctx.fillStyle = GREEN;
      ctx.fillRect(r.x, r.y + r.h * reveal, r.w, 2);
    }
    const stage = t < 0.35 ? "INITIALIZING" : t < 0.8 ? "CONNECTING" : "DOWNLOADING";
    const label = this.labels.get(stage) ?? stage;
    const dots = ".".repeat(1 + (Math.floor(t * 6) % 3));
    this.font.draw(ctx, label + dots, r.x + r.w / 2, r.y + r.h / 2, { color: GREEN, align: "center" });
  }

  /** Re-render the satellite image when the view leaves it or zooms well past its resolution. */
  private ensureSnapshot(r: { x: number; y: number; w: number; h: number }) {
    const viewSpan = Math.max(r.w, r.h) * this.view.scale * METRE;
    const snap = this.snapshot;
    if (snap && !this.wantSnapshot) {
      const half = snap.span / 2;
      const inside = Math.abs(this.view.x - snap.x) + viewSpan / 2 <= half * 1.02 && Math.abs(this.view.y - snap.y) + viewSpan / 2 <= half * 1.02;
      const texel = snap.span / IMAGE / (this.view.scale * METRE);
      if (inside && texel < 2.2 && texel > 0.3) return;
      if (this.drag) return;
    }
    this.wantSnapshot = false;
    this.snapshot = this.render(this.view.x, this.view.y, viewSpan * 1.6);
  }

  private render(x: number, y: number, span: number): Snapshot | null {
    const game = this.game;
    const renderer = game.renderer;
    this.target ??= new THREE.WebGLRenderTarget(IMAGE, IMAGE, { colorSpace: THREE.SRGBColorSpace });
    const top = (game.services.player?.eye()[2] ?? game.origin[2]) + 3000 * METRE;
    const camera = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 1 * METRE, 8000 * METRE);
    camera.position.copy(game.toScene([x, y, top]));
    camera.up.set(0, 0, -1); // north (IGI +Y) is three's -Z
    camera.lookAt(game.toScene([x, y, top - METRE]));
    camera.updateMatrixWorld();

    // Only the level itself: no sky, no fog, no background colour.
    const hidden: THREE.Object3D[] = [];
    for (const child of game.scene.children) {
      if (child !== game.world && !(child as THREE.Light).isLight && child.visible) {
        child.visible = false;
        hidden.push(child);
      }
    }
    const fog = game.scene.fog;
    const background = game.scene.background;
    game.scene.fog = null;
    game.scene.background = new THREE.Color(0x0a140b);
    const fogUniforms: { u: THREE.IUniform; v: unknown }[] = [];
    game.world.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | THREE.ShaderMaterial[] | undefined;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        for (const name of ["fogNear", "fogFar"]) {
          const u = mat.uniforms?.[name];
          if (u) {
            fogUniforms.push({ u, v: u.value });
            u.value = 1e12;
          }
        }
      }
    });
    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.target);
      renderer.clear();
      // Extra light from above so roofs read on the satellite image.
      const sun = new THREE.AmbientLight(0xffffff, 1.5);
      game.scene.add(sun);
      renderer.render(game.scene, camera);
      game.scene.remove(sun);
      const pixels = new Uint8Array(IMAGE * IMAGE * 4);
      renderer.readRenderTargetPixels(this.target, 0, 0, IMAGE, IMAGE, pixels);
      // WebGL rows run bottom-up.
      const flipped = new Uint8ClampedArray(IMAGE * IMAGE * 4);
      for (let row = 0; row < IMAGE; row++) flipped.set(pixels.subarray(row * IMAGE * 4, (row + 1) * IMAGE * 4), (IMAGE - 1 - row) * IMAGE * 4);
      const canvas = this.snapshot?.canvas ?? Object.assign(document.createElement("canvas"), { width: IMAGE, height: IMAGE });
      canvas.getContext("2d")!.putImageData(new ImageData(flipped, IMAGE, IMAGE), 0, 0);
      return { canvas, x, y, span };
    } catch (err) {
      console.warn("map render failed:", err);
      return this.snapshot;
    } finally {
      renderer.setRenderTarget(previous);
      for (const { u, v } of fogUniforms) u.value = v;
      game.scene.fog = fog;
      game.scene.background = background;
      for (const o of hidden) o.visible = true;
    }
  }

  dispose() {
    for (const c of this.cleanup) c();
    this.target?.dispose();
    this.root.remove();
  }
}
