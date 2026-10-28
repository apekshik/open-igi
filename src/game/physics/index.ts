// Physics: IGI's own collision data. Static models collide with their .mef collision sets (the material-tagged "hit"
// shape for rays, the pre-grown "human" hull for movement), terrain with the octree's leaf meshes at full detail,
// entities with vertical capsules. Doors, elevators, vehicles and trains register dynamic colliders (addDynamic) whose
// pose their owners update every frame; this system carries characters standing on them and pushes characters out of
// their way. See load.ts / world.ts, docs/formats/collision.md and docs/formats/dynamic.md.
import * as THREE from "three";
import { METRE, vec3, type Vec3 } from "../coords.ts";
import type { Game, GameSystem } from "../game.ts";
import type { Placement } from "../../level/objects.ts";
import { decodeCollision, type ModelCollision } from "../../formats/collision.ts";
import type { DynamicCollider, GroundHit, MoveOptions, MoveResult, PhysicsService, RayHit, RaycastOptions } from "./api.ts";
import { gatesOpen } from "../mission/gates.ts";
import { buildCollisionWorld, placementMatrix, type PlacedModel } from "./load.ts";
import { bulletsPass, loadMagicObjTypes } from "./materials.ts";
import { toLocal, toWorld, type CollisionWorld, type DynamicBody, type GroundInfo } from "./world.ts";

export function physicsSystem(): GameSystem {
  let gated: { index: number; gates: number[]; on: boolean }[] = [];
  let collision: CollisionWorld | null = null;
  return {
    name: "physics",
    update(_dt, game) {
      for (const g of gated) {
        const on = gatesOpen(game, g.gates);
        if (on !== g.on) collision?.setObjectEnabled(g.index, (g.on = on));
      }
    },
    async init(game) {
      const started = performance.now();
      const placed: PlacedModel[] = [];
      for (const object of game.staticObjects) {
        const placement = object.userData.placement as Placement | undefined;
        // Models riding a vehicle (train cargo, the Hueys' cabin props) collide as dynamic colliders the world system
        // moves with their vehicle, not where the level left them.
        if (!placement || placement.carrier) continue;
        object.updateMatrix();
        placed.push({ placement, matrix: object.matrix.elements });
        // Attached sub-models (building interiors, fittings) that the world system adds as children: they carry their
        // own collision sets.
        object.traverse((child) => {
          const model = child.userData.attachment as string | undefined;
          if (!model || child === object) return;
          const matrix = new THREE.Matrix4();
          for (let n: THREE.Object3D | null = child; n && n !== object.parent; n = n.parent) matrix.premultiply(n.matrix);
          placed.push({ placement: { ...placement, model }, matrix: matrix.elements });
        });
      }
      const world = await buildCollisionWorld(game.vfs, game.level, game.origin, placed);
      // Terrain columns around the start, so the first shots and steps don't pay for building them.
      const columns = world.terrain?.prewarm(game.origin[0], game.origin[1], PREWARM_RADIUS) ?? 0;
      const physics = new IgiPhysics(game, world);
      for (const [model, type] of await loadMagicObjTypes(game.vfs)) if (type === "LADDER") physics.ladders.add(model);
      game.services.physics = physics;
      // Models inside ConditionalContainers (elevator-shaft blockers that exist only while the car moves, intact and
      // destroyed variants) collide only while their containers run.
      gated = world.objects.flatMap((o, index) => (o.gates?.length ? [{ index, gates: o.gates, on: true }] : []));
      collision = world;
      const s = world.stats;
      console.info(
        `physics: ${s.objects} objects, ${s.hitTriangles} hit + ${s.hullTriangles} hull triangles, ${columns} terrain columns, ` +
          `${(performance.now() - started).toFixed(0)} ms`,
      );
    },
    // After every system's update (doors, elevators and vehicles have moved this frame, characters have walked) and
    // before the player places its camera: riders move with their platform in the same frame.
    lateUpdate(_dt, game) {
      if (!game.paused) (game.services.physics as IgiPhysics | undefined)?.carry?.();
    },
  };
}

/** Is a model-space feet point over the collider's footprint (and not far above or below it)? */
function insideFootprint(bounds: readonly number[], p: readonly number[], radius: number): boolean {
  const m = radius * 0.5;
  return p[0] >= bounds[0] - m && p[0] <= bounds[3] + m && p[1] >= bounds[1] - m && p[1] <= bounds[4] + m && p[2] >= bounds[2] - 0.5 * METRE && p[2] <= bounds[5];
}

/** Entity kinds that ride platforms and get pushed by moving colliders. */
const RIDERS = new Set(["player", "soldier", "civilian", "human"]);

const PREWARM_RADIUS = 150 * METRE;

/** Body regions by height on the hit volume (fraction of the entity's height). */
const HEAD_FROM = 0.86;
const TORSO_FROM = 0.5;

export class IgiPhysics implements PhysicsService {
  readonly world: CollisionWorld;
  /** Climbable ladder models (magicobj.qvm TASKTYPE_LADDER). */
  readonly ladders = new Set<string>();
  private game: Game;

  constructor(game: Game, world: CollisionWorld) {
    this.game = game;
    this.world = world;
  }

  private groundHit(g: GroundInfo | null): GroundHit | null {
    if (!g) return null;
    const hit: GroundHit = { z: g.z, normal: g.normal, material: this.world.materialName(g.material) };
    if (g.body >= 0) hit.platform = g.body;
    return hit;
  }

  groundHeight(x: number, y: number, fromZ?: number): number | null {
    return this.world.ground(x, y, fromZ)?.z ?? null;
  }

  ground(x: number, y: number, fromZ?: number): GroundHit | null {
    return this.groundHit(this.world.ground(x, y, fromZ));
  }

  raycast(from: Vec3, to: Vec3, options?: RaycastOptions): RayHit | null {
    const w = this.world.raycast(from, to);
    let best: RayHit | null = w && {
      point: w.point,
      normal: w.normal,
      distance: w.distance,
      entityId: null,
      material: this.world.materialName(w.material),
      part: this.world.materialName(w.material),
      model: w.object >= 0 ? this.world.objects[w.object].model : undefined,
    };
    // Bullets fly on through fences and glass.
    const info = w && options?.bullet ? this.world.materials[w.material] : undefined;
    if (w && info && bulletsPass(info)) return this.raycastPast(from, to, w.distance, options);
    if (best?.model && this.ladders.has(best.model)) best.ladder = true;
    if (best && w && w.body >= 0) {
      const body = this.colliders.get(w.body);
      best.collider = w.body;
      best.model = body?.model;
      if (body?.entityId != null) {
        if (body.entityId === options?.ignoreEntity) return this.raycastPast(from, to, w.distance, options);
        if (options?.entities !== false) best.entityId = body.entityId;
      }
    }
    if (options?.entities === false) return best;
    const d = vec3.sub(to, from);
    const len = vec3.length(d);
    if (len === 0) return best;
    for (const e of this.game.entities.all()) {
      if (!e.alive || e.id === options?.ignoreEntity || e.radius <= 0 || e.height <= 0) continue;
      const t = rayCapsule(from, d, e.position, e.radius, e.height);
      if (t === null) continue;
      const dist = t * len;
      if (best && dist >= best.distance) continue;
      const point = vec3.add(from, vec3.scale(d, t));
      const rel = (point[2] - e.position[2]) / e.height;
      const axisZ = Math.min(Math.max(point[2], e.position[2] + e.radius), e.position[2] + e.height - e.radius);
      best = {
        point,
        normal: vec3.normalize([point[0] - e.position[0], point[1] - e.position[1], point[2] - axisZ]),
        distance: dist,
        entityId: e.id,
        part: rel > HEAD_FROM ? "head" : rel > TORSO_FROM ? "torso" : "legs",
      };
    }
    return best;
  }

  /** Continue a ray past a collider owned by the ignored entity (a vehicle's own gunner shooting out). */
  private raycastPast(from: Vec3, to: Vec3, distance: number, options?: RaycastOptions): RayHit | null {
    const d = vec3.sub(to, from);
    const len = vec3.length(d);
    const skip = distance + 0.05 * METRE;
    if (skip >= len) return null;
    const hit = this.raycast(vec3.add(from, vec3.scale(d, skip / len)), to, options);
    if (hit) hit.distance += skip;
    return hit;
  }

  // ------------------------------------------------------------------------------------------- dynamic colliders

  private colliders = new Map<number, DynamicBody & { model: string }>();
  private collisionCache = new Map<string, ModelCollision | null>();
  private stats = { colliders: 0, moved: 0, carried: 0, pushed: 0, ms: 0 };
  /** The collider each rider was carried by last frame: riders stay on while inside its footprint. */
  private riding = new WeakMap<object, DynamicBody>();

  addDynamic(model: string, matrix: ArrayLike<number>, options?: { entityId?: number }): DynamicCollider | null {
    let collision = this.collisionCache.get(model);
    if (collision === undefined) {
      const bytes = this.game.level.library.bytes(model);
      collision = null;
      try {
        collision = bytes ? decodeCollision(bytes) : null;
      } catch (e) {
        console.warn(`collision for ${model}: ${(e as Error).message}`);
      }
      this.collisionCache.set(model, collision);
    }
    if (!collision) return null;
    const body = this.world.addBody(model, collision, matrix, options?.entityId ?? null);
    if (!body) return null;
    this.colliders.set(body.id, body);
    const world = this.world;
    const colliders = this.colliders;
    const origin = this.game.origin;
    return {
      id: body.id,
      model,
      setMatrix: (m) => body.setMatrix(m),
      carve: (m) => world.carve(body, m ?? body.matrix),
      overlaps: (feet, radius, height) => body.enabled && world.pushOut(body, feet, radius, height, [0, 0]) !== null,
      setPose: (position, rotation) => body.setMatrix(placementMatrix({ type: "", name: "", id: -1, model, position, rotation }, origin)),
      get enabled() {
        return body.enabled;
      },
      set enabled(v: boolean) {
        if (v && !body.enabled) body.settle();
        body.enabled = v;
      },
      get entityId() {
        return body.entityId;
      },
      set entityId(v: number | null) {
        body.entityId = v;
      },
      remove: () => {
        world.removeBody(body);
        colliders.delete(body.id);
      },
    };
  }

  dynamicStats() {
    return { ...this.stats };
  }

  /**
   * Once per frame, before characters move: characters standing on a collider that moved since the last frame move
   * with it (elevators, trains, vehicles); characters the collider now overlaps are pushed along by its motion (doors
   * swinging into them, vehicles driving into them).
   */
  carry() {
    const started = performance.now();
    const [gx, gy, gz] = this.game.origin;
    let moved = 0;
    let carried = 0;
    let pushed = 0;
    let riders: { position: Vec3; radius: number; height: number; alive: boolean }[] | null = null;
    const done = new Set<object>();
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    for (const body of this.world.bodies) {
      if (!body.enabled || !body.moved) continue;
      moved++;
      riders ??= this.game.entities.all().filter((e) => e.alive && e.radius > 0 && RIDERS.has(e.kind));
      // Characters near the collider at its old or new pose.
      const lo = [Math.min(body.box[0], body.oldBox[0]) + gx, Math.min(body.box[1], body.oldBox[1]) + gy, Math.min(body.box[2], body.oldBox[2]) + gz];
      const hi = [Math.max(body.box[3], body.oldBox[3]) + gx, Math.max(body.box[4], body.oldBox[4]) + gy, Math.max(body.box[5], body.oldBox[5]) + gz];
      for (const e of riders) {
        const p = e.position;
        const m = e.radius + 0.6 * METRE;
        if (done.has(e) || p[0] < lo[0] - m || p[0] > hi[0] + m || p[1] < lo[1] - m || p[1] > hi[1] + m || p[2] > hi[2] + 0.5 * METRE || p[2] + e.height < lo[2]) continue;
        // Where the point attached to the collider's old pose is now.
        toLocal(body.carried, p[0] - gx, p[1] - gy, p[2] - gz, a);
        toWorld(body.matrix, a[0], a[1], a[2], b);
        // Riders stay with the collider they were on while their feet are inside its footprint, even when the support
        // test slips (a truck bed pitching up a steep hill); stepping off its edge releases them.
        const sticky = this.riding.get(e) === body && insideFootprint(body.localBounds, a, e.radius);
        if (sticky || this.world.supports(body, body.carried, p, e.radius)) {
          e.position = [b[0] + gx, b[1] + gy, b[2] + gz];
          // Doors move whoever stands on their sill but are no platform: riding one would take the static world away.
          if (this.game.entities.get(body.entityId ?? -1)?.kind !== "door") this.riding.set(e, body);
          done.add(e);
          carried++;
        } else {
          if (this.riding.get(e) === body) this.riding.delete(e);
          // Someone riding another collider moves with that one: a gate opening as the truck rolls through must not
          // shove Jones off the truck bed (riders already ignore other colliders when they move).
          if (this.riding.has(e)) continue;
          const push = this.world.pushOut(body, p, e.radius, e.height, [b[0] + gx - p[0], b[1] + gy - p[1]]);
          if (push) {
            e.position = [p[0] + push[0], p[1] + push[1], p[2]];
            done.add(e);
            pushed++;
          }
        }
      }
      body.settle();
    }
    this.stats = { colliders: this.world.bodies.length, moved, carried, pushed, ms: performance.now() - started };
  }

  lineOfSight(from: Vec3, to: Vec3): boolean {
    return this.world.lineOfSight(from, to);
  }

  move(feet: Vec3, delta: Vec3, radius: number, height: number, options?: MoveOptions): MoveResult {
    const rider = options?.entityId === undefined ? undefined : this.game.entities.get(options.entityId);
    let ridingBody: number | undefined;
    const body = rider ? this.riding.get(rider) : undefined;
    if (rider && body) {
      // Carrying only looks at colliders that moved this frame: a rider who walked off (or was moved off) a collider
      // that has stopped (an elevator car at its floor) is released here, or it would go on ignoring the static world.
      const [gx, gy, gz] = this.game.origin;
      const a = [0, 0, 0];
      toLocal(body.matrix, feet[0] - gx, feet[1] - gy, feet[2] - gz, a);
      if (body.enabled && insideFootprint(body.localBounds, a, radius)) ridingBody = body.id;
      else this.riding.delete(rider);
    }
    const r = this.world.move(feet, delta, radius, height, ridingBody === undefined ? options : { ...options, ridingBody });
    return { position: r.position, grounded: r.grounded, ground: this.groundHit(r.ground) ?? undefined };
  }
}

/**
 * Segment from o along d (t in 0..1) against a vertical capsule standing at `base` (radius r, total height h).
 * Returns the entry t or null.
 */
export function rayCapsule(o: Vec3, d: Vec3, base: Vec3, r: number, h: number): number | null {
  const lo = base[2] + Math.min(r, h / 2);
  const hi = base[2] + Math.max(h - r, h / 2);
  let best: number | null = null;
  // Cylinder side between the cap centres.
  const ox = o[0] - base[0];
  const oy = o[1] - base[1];
  const a = d[0] * d[0] + d[1] * d[1];
  if (a > 0) {
    const b = ox * d[0] + oy * d[1];
    const c = ox * ox + oy * oy - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const z = o[2] + d[2] * t;
      if (t >= 0 && t <= 1 && z >= lo && z <= hi) best = t;
      else if (t < 0 && c <= 0) {
        // Starts inside the infinite cylinder: inside the capsule if between the caps.
        if (o[2] >= lo && o[2] <= hi) return 0;
      }
    }
  }
  // End spheres.
  for (const cz of [lo, hi]) {
    const sx = o[0] - base[0];
    const sy = o[1] - base[1];
    const sz = o[2] - cz;
    const qa = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const qb = sx * d[0] + sy * d[1] + sz * d[2];
    const qc = sx * sx + sy * sy + sz * sz - r * r;
    if (qc <= 0) return 0;
    const disc = qb * qb - qa * qc;
    if (disc < 0) continue;
    const t = (-qb - Math.sqrt(disc)) / qa;
    if (t >= 0 && t <= 1 && (best === null || t < best)) best = t;
  }
  return best;
}
