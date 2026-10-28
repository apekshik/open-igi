// STUB physics: three.js raycasts against whatever is rendered (terrain + static models). Good enough to walk and
// shoot; the physics system replaces this with IGI's own collision meshes and terrain height queries.
import * as THREE from "three";
import { vec3, type Vec3 } from "../coords.ts";
import type { Game, GameSystem } from "../game.ts";
import type { PhysicsService, RayHit } from "./api.ts";

export function physicsSystem(): GameSystem {
  return {
    name: "physics",
    init(game) {
      game.services.physics = new RaycastPhysics(game);
    },
  };
}

class RaycastPhysics implements PhysicsService {
  private ray = new THREE.Raycaster();
  private game: Game;

  constructor(game: Game) {
    this.game = game;
  }

  private targets(): THREE.Object3D[] {
    return [...this.game.staticObjects, ...(this.game.terrain ? [this.game.terrain.group.children[0]].filter(Boolean) : [])];
  }

  private cast(from: Vec3, to: Vec3): RayHit | null {
    const dir = vec3.sub(to, from);
    const len = vec3.length(dir);
    if (len === 0) return null;
    this.ray.set(this.game.toScene(from), this.game.toSceneDir(vec3.scale(dir, 1 / len)));
    this.ray.far = len;
    const hit = this.ray.intersectObjects(this.targets(), true)[0];
    if (!hit) return null;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { point: this.game.fromScene(hit.point), normal: [n.x, -n.z, n.y], distance: hit.distance, entityId: null };
  }

  groundHeight(x: number, y: number, fromZ = 2 ** 30): number | null {
    const hit = this.cast([x, y, fromZ], [x, y, -(2 ** 30)]);
    return hit ? hit.point[2] : null;
  }

  raycast(from: Vec3, to: Vec3, options?: { ignoreEntity?: number; entities?: boolean }): RayHit | null {
    const hit = this.cast(from, to);
    if (options?.entities === false) return hit;
    // Entities as vertical capsules (approximated by cylinders).
    let best = hit;
    const d = vec3.sub(to, from);
    const len = vec3.length(d);
    for (const e of this.game.entities.all()) {
      if (!e.alive || e.id === options?.ignoreEntity || e.radius <= 0) continue;
      const t = rayCylinder(from, d, e.position, e.radius, e.height);
      if (t === null) continue;
      const dist = t * len;
      if (best && dist >= best.distance) continue;
      const point = vec3.add(from, vec3.scale(d, t));
      const rel = (point[2] - e.position[2]) / e.height;
      best = { point, normal: vec3.normalize([point[0] - e.position[0], point[1] - e.position[1], 0]), distance: dist, entityId: e.id, part: rel > 0.85 ? "head" : rel > 0.45 ? "torso" : "legs" };
    }
    return best;
  }

  lineOfSight(from: Vec3, to: Vec3): boolean {
    return this.cast(from, to) === null;
  }

  move(feet: Vec3, delta: Vec3, radius: number, height: number) {
    const next: Vec3 = vec3.add(feet, delta);
    // Block horizontal motion into walls at knee and chest height.
    for (const h of [height * 0.35, height * 0.8]) {
      const a: Vec3 = [feet[0], feet[1], feet[2] + h];
      const horiz: Vec3 = [delta[0], delta[1], 0];
      const l = vec3.length(horiz);
      if (l > 0 && this.cast(a, vec3.add(a, vec3.scale(horiz, (l + radius) / l)))) {
        next[0] = feet[0];
        next[1] = feet[1];
        break;
      }
    }
    const ground = this.groundHeight(next[0], next[1], next[2] + height * 0.4);
    if (ground !== null && next[2] <= ground + 1) return { position: [next[0], next[1], ground] as Vec3, grounded: true };
    return { position: next, grounded: false };
  }
}

/** Ray (origin o, direction d, t in 0..1) against a vertical cylinder; returns t or null. */
function rayCylinder(o: Vec3, d: Vec3, base: Vec3, r: number, h: number): number | null {
  const ox = o[0] - base[0];
  const oy = o[1] - base[1];
  const a = d[0] * d[0] + d[1] * d[1];
  if (a === 0) return null;
  const b = 2 * (ox * d[0] + oy * d[1]);
  const c = ox * ox + oy * oy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1) return null;
  const z = o[2] + d[2] * t - base[2];
  return z >= 0 && z <= h ? t : null;
}
