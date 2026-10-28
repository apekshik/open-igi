// The game runtime: loads a level, owns the scene, camera, input, entities and event bus, and runs every system
// once per frame. Systems (src/game/<system>/index.ts) do all gameplay; see src/game/systems.ts for the order.

import * as THREE from "three";
import { loadLevel, METRE, type LoadedLevel } from "../level/load.ts";
import { TerrainRenderer } from "../render/terrain.ts";
import type { Vfs } from "../vfs/vfs.ts";
import { toThreeDir, type Vec3 } from "./coords.ts";
import { EntityRegistry } from "./entity.ts";
import { EventBus } from "./events.ts";
import { Input } from "./input.ts";
import type { Services } from "./services.ts";

export interface GameSystem {
  readonly name: string;
  /** Called once after the level and static world are loaded, in system order. Publish services here. */
  init?(game: Game): void | Promise<void>;
  /** Called every frame in system order (dt in seconds, clamped). Not called while paused. */
  update?(dt: number, game: Game): void;
  /** Called every frame after update, even while paused (UI). */
  lateUpdate?(dt: number, game: Game): void;
  dispose?(game: Game): void;
}

export interface GameOptions {
  vfs: Vfs;
  /** Element the canvas and HUD overlay go into. */
  host: HTMLElement;
  /** "level1".."level14". */
  level: string;
  systems: GameSystem[];
  /** Terrain level-of-detail multiplier (1 = original game). */
  detail?: number;
  /** Load steps as text, with the fraction done (0..1). */
  onProgress?: (text: string, fraction?: number) => void;
}

export class Game {
  readonly vfs: Vfs;
  readonly events = new EventBus();
  readonly entities = new EntityRegistry();
  readonly services: Services = {};
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05 * METRE, 20000 * METRE);
  readonly renderer: THREE.WebGLRenderer;
  /** IGI-space root: children use IGI coordinates relative to `origin` (see coords.ts). */
  readonly world = new THREE.Group();
  /** DOM layer over the canvas for HUD and menus. */
  readonly overlay: HTMLDivElement;
  readonly input: Input;
  readonly systems: GameSystem[];
  level!: LoadedLevel;
  terrain: TerrainRenderer | null = null;
  /** Placed static models (buildings, props), for physics and rendering systems. */
  readonly staticObjects: THREE.Object3D[] = [];
  /** World offset subtracted before rendering (the player start). */
  origin: Vec3 = [0, 0, 0];
  /** Seconds of unpaused game time. */
  time = 0;
  paused = false;
  private running = false;
  private last = 0;
  private options: GameOptions;
  private resizer: ResizeObserver;

  private constructor(options: GameOptions) {
    this.options = options;
    this.vfs = options.vfs;
    this.systems = options.systems;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const host = options.host;
    host.style.position ||= "relative";
    this.renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    host.append(this.renderer.domElement);
    this.overlay = Object.assign(document.createElement("div"), { style: "position:absolute;inset:0;pointer-events:none;overflow:hidden" });
    host.append(this.overlay);
    this.input = new Input(this.renderer.domElement);
    this.world.rotation.x = -Math.PI / 2;
    this.scene.add(this.world);
    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x3a3328, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun);
    this.camera.rotation.order = "YXZ";
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.resize();
  }

  static async start(options: GameOptions): Promise<Game> {
    const game = new Game(options);
    await game.load();
    game.run();
    return game;
  }

  private async load() {
    // Report each step with the fraction done, and yield so the loading screen can repaint between steps.
    const progress = async (text: string, fraction: number) => {
      this.options.onProgress?.(text, fraction);
      await yieldTask();
    };
    await progress(`loading ${this.options.level}...`, 0.02);
    this.level = await loadLevel(this.vfs, this.options.level);
    this.origin = this.level.objects.playerStart ?? this.level.objects.placements[0]?.position ?? [0, 0, 0];

    await progress("placing objects...", 0.35);
    for (const p of this.level.objects.placements) {
      const built = this.level.library.build(p.model);
      if (!built) continue;
      const mesh = new THREE.Mesh(built.geometry, built.materials);
      mesh.position.copy(this.local(p.position));
      mesh.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2], "ZYX");
      mesh.userData.placement = p;
      this.world.add(mesh);
      this.staticObjects.push(mesh);
    }
    this.world.updateMatrixWorld(true);

    for (const [i, s] of this.systems.entries()) {
      await progress(`starting ${s.name}...`, 0.4 + (0.45 * i) / this.systems.length);
      await s.init?.(this);
    }

    await progress("building terrain...", 0.86);
    const fog = this.services.world?.fog ?? { color: 0x9aa7b4, near: 300 * METRE, far: 4000 * METRE };
    this.terrain = new TerrainRenderer({
      ...this.level.terrain,
      origin: this.origin,
      radius: 6000 * METRE,
      minLevel: 7,
      detail: this.options.detail ?? 4,
      fog: { color: new THREE.Color(fog.color), near: fog.near, far: fog.far },
      rebuildDistance: 8 * METRE,
    });
    this.world.add(this.terrain.group);
    this.terrain.update(this.services.player?.eye() ?? this.origin);
    this.world.updateMatrixWorld(true);
    await progress("preparing shaders...", 0.92);
    await this.warmUp();
    this.events.emit("level:loaded", { level: this.level.name });
    this.options.onProgress?.("", 1);
  }

  /**
   * Compile every material's shader and upload every texture now, so the first look at a building or a soldier
   * does not stall a frame for 100+ ms mid-game.
   */
  private async warmUp() {
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) textures.add(v as THREE.Texture);
        const uniforms = (mat as THREE.ShaderMaterial).uniforms;
        if (uniforms) for (const u of Object.values(uniforms)) if ((u.value as THREE.Texture)?.isTexture) textures.add(u.value);
      }
    });
    for (const t of textures) this.renderer.initTexture(t);
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch (err) {
      console.warn("shader warm-up failed", err);
    }
  }

  private run() {
    this.running = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop((now) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (!this.paused) {
        this.time += dt;
        for (const s of this.systems) if (s.update) this.guard(s, s.update, dt);
      }
      for (const s of this.systems) if (s.lateUpdate) this.guard(s, s.lateUpdate, dt);
      this.terrain?.update(this.fromScene(this.camera.position));
      this.renderer.render(this.scene, this.camera);
      this.input.endFrame();
    });
  }

  private failed = new Set<string>();

  /** Run one system step; an exception is logged (once per system) instead of stopping the frame loop. */
  private guard(s: GameSystem, fn: (dt: number, game: Game) => void, dt: number) {
    try {
      fn.call(s, dt, this);
    } catch (err) {
      if (this.failed.has(s.name)) return;
      this.failed.add(s.name);
      console.error(`${s.name} system failed (further errors from it are not logged):`, err);
    }
  }

  /** Point the camera from an IGI-space eye position with yaw/pitch (radians) and a vertical FOV in degrees. */
  setView(eye: Vec3, yaw: number, pitch: number, fov = 70, roll = 0) {
    this.camera.position.copy(this.toScene(eye));
    this.camera.rotation.set(pitch, yaw, roll, "YXZ");
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** IGI world position → position for a child of `world` (origin-relative, still Z up). */
  local(p: Vec3): THREE.Vector3 {
    return new THREE.Vector3(p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]);
  }

  /** IGI world position → three.js scene position. */
  toScene(p: Vec3): THREE.Vector3 {
    return new THREE.Vector3(p[0] - this.origin[0], p[2] - this.origin[2], -(p[1] - this.origin[1]));
  }

  /** IGI direction → three.js scene direction. */
  toSceneDir(d: Vec3): THREE.Vector3 {
    return toThreeDir(d);
  }

  /** three.js scene position → IGI world position. */
  fromScene(v: THREE.Vector3): Vec3 {
    return [v.x + this.origin[0], -v.z + this.origin[1], v.y + this.origin[2]];
  }

  private resize() {
    const host = this.options.host;
    const w = host.clientWidth || innerWidth;
    const h = host.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    for (const s of this.systems) s.dispose?.(this);
    this.terrain?.dispose();
    this.input.dispose();
    // The host element outlives the game: an observer left on it would keep this whole Game (level, scene) alive.
    this.resizer.disconnect();
    this.renderer.dispose();
    // Free the WebGL context now; browsers cap live contexts (about 16) and restarts would run into the cap.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }
}

/** Let the browser run other tasks (and paint). A message, unlike setTimeout, is not throttled in background tabs. */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
}
