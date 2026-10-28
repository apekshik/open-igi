// Physics: IGI's own collision data. Static models collide with their .mef collision sets (the material-tagged "hit"
// shape for rays, the pre-grown "human" hull for movement), terrain with the octree's leaf meshes at full detail,
// entities with vertical capsules. See load.ts / world.ts and docs/formats/collision.md.
import * as THREE from "three";
import { METRE, vec3, type Vec3 } from "../coords.ts";
import type { Game, GameSystem } from "../game.ts";
import type { Placement } from "../../level/objects.ts";
import type { GroundHit, MoveOptions, MoveResult, PhysicsService, RayHit, RaycastOptions } from "./api.ts";
import { gatesOpen } from "../mission/gates.ts";
import { buildCollisionWorld, type PlacedModel } from "./load.ts";
import type { CollisionWorld, GroundInfo } from "./world.ts";

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
        if (!placement) continue;
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
      game.services.physics = new IgiPhysics(game, world);
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
  };
}

const PREWARM_RADIUS = 150 * METRE;

/** Body regions by height on the hit volume (fraction of the entity's height). */
const HEAD_FROM = 0.86;
const TORSO_FROM = 0.5;

export class IgiPhysics implements PhysicsService {
  readonly world: CollisionWorld;
  private game: Game;

  constructor(game: Game, world: CollisionWorld) {
    this.game = game;
    this.world = world;
  }

  private groundHit(g: GroundInfo | null): GroundHit | null {
    return g && { z: g.z, normal: g.normal, material: this.world.materialName(g.material) };
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

  lineOfSight(from: Vec3, to: Vec3): boolean {
    return this.world.lineOfSight(from, to);
  }

  move(feet: Vec3, delta: Vec3, radius: number, height: number, options?: MoveOptions): MoveResult {
    const r = this.world.move(feet, delta, radius, height, options);
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
