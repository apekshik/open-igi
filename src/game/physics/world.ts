// The static collision world: every placed model's collision sets in one BVH, plus leaf-detail terrain. Pure (no
// three.js, no Game), so tools and tests can build it from level files directly.
//
// Internally everything is relative to `origin` (float32 storage stays sub-millimetre). The public methods take and
// return absolute IGI units.

import { NO_MATERIAL, type ModelCollision } from "../../formats/collision.ts";
import type { TerrainData } from "../../level/terrain.ts";
import { TRI_HULL, TRI_MOVE, TRI_RAY, TRI_SIGHT, TRI_THIN, TriangleBvh, triangleNormal } from "./bvh.ts";
import type { GameMaterial } from "./materials.ts";
import { TerrainCollider, type TerrainDiscard } from "./terrain.ts";

const METRE = 4096;

/**
 * How far a model's human hull (collision set 1) already sticks out past its real shape, per side. Measured over every
 * model that has both sets (tools/collision.ts): median 808 units, i.e. about 0.2 m. Movement against a hull uses
 * the capsule radius minus this.
 */
export const HULL_GROWTH = 808;
/** Smallest radius used against hulls, so a thin capsule still slides cleanly. */
const MIN_HULL_RADIUS = 0.06 * METRE;
/** How far under a hull's top to look for the real surface's material. */
const HULL_MATERIAL_DEPTH = 0.4 * METRE;
/** Radius against the real shape of models that have a hull. */
const THIN_RADIUS = 0.1 * METRE;

// Candidate kinds: which radius a triangle is tested with.
const KIND_SOLID = 0;
const KIND_HULL = 1;
const KIND_THIN = 2;
/** Default highest ledge a character steps onto without jumping. */
export const DEFAULT_STEP_HEIGHT = 0.45 * METRE;
/** Default steepest walkable slope (normal z of a 50 degree slope). */
export const DEFAULT_WALKABLE_Z = Math.cos((50 * Math.PI) / 180);

export interface StaticObjectInput {
  /** Model name (for reporting). */
  model: string;
  collision: ModelCollision;
  /** Column-major 4x4 (three.js `Matrix4.elements` layout): model space → origin-relative IGI space. */
  matrix: ArrayLike<number>;
}

export interface WorldOptions {
  origin: [number, number, number];
  terrain: TerrainData | null;
  /** Game material per terrain material (terrain.qvm). */
  terrainGameMaterials?: number[];
  materials: GameMaterial[];
  objects: StaticObjectInput[];
  /** DiscardTerrain tasks: octree cubes with no terrain surface. */
  discards?: TerrainDiscard[];
}

export interface WorldHit {
  /** Distance along the segment, IGI units. */
  distance: number;
  point: [number, number, number];
  /** Unit normal facing back along the ray. */
  normal: [number, number, number];
  /** Game material id, or -1 when unknown. */
  material: number;
  /** Index into WorldOptions.objects, or -1 for terrain. */
  object: number;
  /** Id of the dynamic body hit, or -1. */
  body: number;
}

export interface GroundInfo {
  z: number;
  normal: [number, number, number];
  material: number;
  object: number;
  /** Id of the dynamic body stood on (a platform), or -1. */
  body: number;
}

export interface MoveOptions {
  stepHeight?: number;
  /** Minimum normal z of a surface the capsule can stand on. */
  walkableZ?: number;
}

export interface MoveResult {
  position: [number, number, number];
  grounded: boolean;
  /** What the feet stand on (when grounded). */
  ground: GroundInfo | null;
}

// Candidate triangle storage for one move (origin-relative, float64).
class Candidates {
  n = 0;
  pos = new Float64Array(9 * 256);
  normal = new Float64Array(3 * 256);
  box = new Float64Array(6 * 256);
  kind = new Uint8Array(256);
  material = new Int32Array(256);
  object = new Int32Array(256);
  body = new Int32Array(256);

  clear() {
    this.n = 0;
  }

  push(p: ArrayLike<number>, q: number, kind: number, material: number, object: number, body = -1) {
    if (this.n === this.kind.length) this.grow();
    const i = this.n++;
    for (let k = 0; k < 9; k++) this.pos[i * 9 + k] = p[q + k];
    const n = triangleNormal(this.pos, i * 9, scratchNormal);
    this.normal[i * 3] = n[0];
    this.normal[i * 3 + 1] = n[1];
    this.normal[i * 3 + 2] = n[2];
    for (let k = 0; k < 3; k++) {
      const a = this.pos[i * 9 + k];
      const b = this.pos[i * 9 + 3 + k];
      const c = this.pos[i * 9 + 6 + k];
      this.box[i * 6 + k] = Math.min(a, b, c);
      this.box[i * 6 + 3 + k] = Math.max(a, b, c);
    }
    this.kind[i] = kind;
    this.material[i] = material;
    this.object[i] = object;
    this.body[i] = body;
  }

  private grow() {
    const m = this.kind.length * 2;
    const g = <T extends Float64Array | Uint8Array | Int32Array>(a: T, per: number): T => {
      const b = new (a.constructor as new (n: number) => T)(m * per);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, 9);
    this.normal = g(this.normal, 3);
    this.box = g(this.box, 6);
    this.kind = g(this.kind, 1);
    this.material = g(this.material, 1);
    this.object = g(this.object, 1);
    this.body = g(this.body, 1);
  }
}

const scratchNormal = [0, 0, 0];

export class CollisionWorld {
  readonly origin: [number, number, number];
  readonly bvh: TriangleBvh;
  readonly terrain: TerrainCollider | null;
  readonly materials: GameMaterial[];
  readonly objects: StaticObjectInput[];
  /** Triangle counts by kind, for reporting. */
  readonly stats: { objects: number; hitTriangles: number; hullTriangles: number; skipped: number };
  private cand = new Candidates();
  private queryOut: number[] = [];

  constructor(options: WorldOptions) {
    this.origin = options.origin;
    this.materials = options.materials;
    this.objects = options.objects;
    this.terrain = options.terrain ? new TerrainCollider(options.terrain, options.origin, options.terrainGameMaterials, options.discards) : null;

    const { soup, hitTriangles, hullTriangles, skipped } = buildSoup(options.objects, this.materials);
    this.bvh = new TriangleBvh(soup);
    this.stats = { objects: options.objects.length - skipped, hitTriangles, hullTriangles, skipped };
  }

  // ---------------------------------------------------------------------------------------------------- dynamic bodies

  /**
   * Add a moving collider (door, elevator car, vehicle, train car): the model's collision sets in model space, placed
   * by an origin-relative column-major matrix that `DynamicBody.setMatrix` updates. Rays, sight, ground and movement
   * see it at its current pose. Returns null for models without usable collision.
   */
  addBody(model: string, collision: ModelCollision, matrix: ArrayLike<number>, entityId: number | null = null): DynamicBody | null {
    if (collision.modelType === 1 || (!collision.hit && !collision.human)) return null;
    const { soup } = buildSoup([{ model, collision, matrix: IDENTITY }], this.materials);
    if (!soup.flags.length) return null;
    const body = new DynamicBody(this.nextBodyId++, model, new TriangleBvh(soup), entityId);
    body.setMatrix(matrix);
    this.bodies.push(body);
    return body;
  }

  /**
   * Drop static (non-hull) triangles lying inside the body's model-space bounds (grown by `margin`) at `matrix`, so a
   * Door object replaces the closed door leaf some buildings carry in their own collision. Returns how many.
   */
  carve(body: DynamicBody, matrix: ArrayLike<number>, margin = 0.05 * METRE): number {
    const box = new Float64Array(6);
    const local = body.localBounds;
    boxOf(matrix, local, box);
    const out: number[] = [];
    this.bvh.query(box[0] - margin, box[1] - margin, box[2] - margin, box[3] + margin, box[4] + margin, box[5] + margin, TRI_RAY | TRI_SIGHT | TRI_MOVE, out);
    const soup = this.bvh.soup;
    const p = soup.positions;
    const v = [0, 0, 0];
    let n = 0;
    for (const tri of out) {
      if (soup.flags[tri] & TRI_HULL) continue;
      let inside = true;
      for (let k = 0; k < 3 && inside; k++) {
        toLocal(matrix, p[tri * 9 + k * 3], p[tri * 9 + k * 3 + 1], p[tri * 9 + k * 3 + 2], v);
        for (let j = 0; j < 3; j++) if (v[j] < local[j] - margin || v[j] > local[3 + j] + margin) inside = false;
      }
      if (!inside) continue;
      soup.flags[tri] = 0;
      n++;
    }
    return n;
  }

  removeBody(body: DynamicBody) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
  }

  readonly bodies: DynamicBody[] = [];
  private nextBodyId = 1;

  materialName(id: number): string | undefined {
    return id >= 0 ? this.materials[id]?.name : undefined;
  }

  // ---------------------------------------------------------------------------------------------------- rays

  /** Nearest static, dynamic-body or terrain hit on the segment from → to among triangles with any of `mask`'s flags. */
  raycast(from: readonly number[], to: readonly number[], mask = TRI_RAY): WorldHit | null {
    const [gx, gy, gz] = this.origin;
    const ox = from[0] - gx, oy = from[1] - gy, oz = from[2] - gz;
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return null;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const s = this.bvh.raycast(ox, oy, oz, ux, uy, uz, len, mask);
    const t = this.terrain?.raycast(ox, oy, oz, ux, uy, uz, s ? s.t : len) ?? null;
    let limit = t ? t.t : s ? s.t : len;
    let bodyHit: { body: DynamicBody; tri: number; t: number } | null = null;
    for (const b of this.bodies) {
      if (!b.enabled || !rayBox(ox, oy, oz, ux, uy, uz, limit, b.box)) continue;
      toLocal(b.matrix, ox, oy, oz, lo);
      dirToLocal(b.matrix, ux, uy, uz, ld);
      const h = b.bvh.raycast(lo[0], lo[1], lo[2], ld[0], ld[1], ld[2], limit, mask);
      if (h) {
        limit = h.t;
        bodyHit = { body: b, tri: h.tri, t: h.t };
      }
    }
    let hit: WorldHit;
    const n = [0, 0, 0];
    if (bodyHit) {
      const { body, tri } = bodyHit;
      triangleNormal(body.bvh.soup.positions, tri * 9, n);
      dirToWorld(body.matrix, n[0], n[1], n[2], n);
      const m = body.bvh.soup.materials[tri];
      hit = { distance: bodyHit.t, point: [0, 0, 0], normal: [n[0], n[1], n[2]], material: m === NO_MATERIAL ? -1 : m, object: -1, body: body.id };
    } else if (t) {
      triangleNormal(t.column.positions, t.tri * 9, n);
      hit = { distance: t.t, point: [0, 0, 0], normal: [n[0], n[1], n[2]], material: this.terrain!.gameMaterial(t.column.materials[t.tri]), object: -1, body: -1 };
    } else if (s) {
      triangleNormal(this.bvh.soup.positions, s.tri * 9, n);
      const m = this.bvh.soup.materials[s.tri];
      hit = { distance: s.t, point: [0, 0, 0], normal: [n[0], n[1], n[2]], material: m === NO_MATERIAL ? -1 : m, object: this.bvh.soup.objects[s.tri], body: -1 };
    } else return null;
    if (hit.normal[0] * ux + hit.normal[1] * uy + hit.normal[2] * uz > 0) hit.normal = [-hit.normal[0], -hit.normal[1], -hit.normal[2]];
    hit.point = [from[0] + ux * hit.distance, from[1] + uy * hit.distance, from[2] + uz * hit.distance];
    return hit;
  }

  lineOfSight(from: readonly number[], to: readonly number[]): boolean {
    return this.raycast(from, to, TRI_SIGHT) === null;
  }

  /**
   * Highest surface a character could stand on under (x, y) at or below fromZ: static models (their movement
   * shape) and terrain. Surfaces steeper than `walkableZ` are ignored.
   */
  ground(x: number, y: number, fromZ = 2 ** 31, walkableZ = 0.3, bodies = true): GroundInfo | null {
    const [gx, gy, gz] = this.origin;
    const top = Math.min(fromZ, 2 ** 31) - gz;
    let best: GroundInfo | null = null;
    const terrain = this.terrain?.ground(x, y);
    if (terrain && terrain.z <= fromZ + 1) best = { z: terrain.z, normal: terrain.normal, material: this.terrain!.gameMaterial(terrain.material), object: -1, body: -1 };
    const floor = best ? best.z - gz - 1 : -(2 ** 31);
    const n = [0, 0, 0];
    const soup = this.bvh.soup;
    const s = this.bvh.raycast(x - gx, y - gy, top, 0, 0, -1, top - floor, TRI_MOVE, (tri) => Math.abs(triangleNormal(soup.positions, tri * 9, n)[2]) >= walkableZ);
    if (s) {
      triangleNormal(soup.positions, s.tri * 9, n);
      if (n[2] < 0) n[0] = -n[0], n[1] = -n[1], n[2] = -n[2];
      let m = soup.materials[s.tri];
      if (soup.flags[s.tri] & TRI_HULL) {
        // Hulls only say "HumanCollision": take the material of the real surface just under it.
        const under = this.bvh.raycast(x - gx, y - gy, top - s.t + 1, 0, 0, -1, HULL_MATERIAL_DEPTH, TRI_RAY);
        if (under) m = soup.materials[under.tri];
      }
      best = { z: top - s.t + gz, normal: [n[0], n[1], n[2]], material: m === NO_MATERIAL ? -1 : m, object: soup.objects[s.tri], body: -1 };
    }
    // Moving platforms (elevator cars, train roofs, vehicles).
    for (const b of bodies ? this.bodies : []) {
      const bottom = best ? best.z - gz : floor;
      const box = b.box;
      if (!b.enabled || box[0] > x - gx || box[3] < x - gx || box[1] > y - gy || box[4] < y - gy || box[2] > top || box[5] < bottom) continue;
      const h = this.bodyGround(b, x - gx, y - gy, top, top - bottom, walkableZ);
      if (h) best = { ...h, z: h.z + gz };
    }
    return best;
  }

  // ---------------------------------------------------------------------------------------------------- movement

  /**
   * Move a vertical capsule (feet at `feet`, radius, height) by `delta`: slide along walls, step up ledges up to the
   * step height, stand only on walkable slopes, never pass through thin geometry (motion is split into steps of at
   * most half the radius).
   */
  move(feet: readonly number[], delta: readonly number[], radius: number, height: number, options: MoveOptions = {}): MoveResult {
    const step = Math.min(options.stepHeight ?? DEFAULT_STEP_HEIGHT, height * 0.5);
    const walkableZ = options.walkableZ ?? DEFAULT_WALKABLE_Z;
    const [gx, gy, gz] = this.origin;
    let px = feet[0] - gx, py = feet[1] - gy, pz = feet[2] - gz;
    const [dx, dy, dz] = delta;
    const hullRadius = Math.max(MIN_HULL_RADIUS, radius - HULL_GROWTH);
    const thinRadius = Math.min(radius, THIN_RADIUS);
    const snap = step * 0.5;

    // Everything the capsule could touch on the way.
    const margin = radius + 1;
    this.gather(
      Math.min(px, px + dx) - margin, Math.min(py, py + dy) - margin, Math.min(pz, pz + dz) - step - margin,
      Math.max(px, px + dx) + margin, Math.max(py, py + dy) + margin, Math.max(pz, pz + dz) + height + margin,
    );
    const c = this.cand;

    const steps = Math.min(256, Math.max(1, Math.ceil(Math.max(Math.hypot(dx, dy), Math.abs(dz)) / (Math.max(hullRadius, 1) * 0.5))));
    let grounded = false;
    let ground: GroundInfo | null = null;
    for (let s = 0; s < steps; s++) {
      const prevX = px, prevY = py;
      px += dx / steps;
      py += dy / steps;

      // Lateral: push the capsule's upper part (above the step height) out of walls, horizontally.
      for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        for (let i = 0; i < c.n; i++) {
          const r = c.kind[i] === KIND_HULL ? hullRadius : c.kind[i] === KIND_THIN ? thinRadius : radius;
          const b = i * 6;
          const z0 = pz + step + r;
          const z1 = Math.max(z0, pz + height - r);
          if (c.box[b] > px + r || c.box[b + 3] < px - r || c.box[b + 1] > py + r || c.box[b + 4] < py - r || c.box[b + 2] > z1 + r || c.box[b + 5] < z0 - r) continue;
          const nz = c.normal[i * 3 + 2];
          if (Math.abs(nz) >= walkableZ) continue; // floors and ceilings: handled vertically
          const d = segmentTriangle(px, py, z0, z1, c.pos, i * 9, closest);
          if (d >= r) continue;
          // Push direction: away from the triangle, on the side the capsule came from (no tunnelling through thin walls).
          const nx = c.normal[i * 3], ny = c.normal[i * 3 + 1];
          const side = (prevX - c.pos[i * 9]) * nx + (prevY - c.pos[i * 9 + 1]) * ny + ((z0 + z1) / 2 - c.pos[i * 9 + 2]) * nz;
          let hx = px - closest[0];
          let hy = py - closest[1];
          let depth = r - d;
          const hl = Math.hypot(hx, hy);
          if (hl < 1e-6 || (hx * nx + hy * ny) * side < 0) {
            // On or through the plane: go back out along the face normal, to the original side.
            const nl = Math.hypot(nx, ny) || 1;
            const sgn = side >= 0 ? 1 : -1;
            hx = (nx / nl) * sgn;
            hy = (ny / nl) * sgn;
            depth = r + d;
          } else {
            hx /= hl;
            hy /= hl;
          }
          px += hx * (depth + 0.5);
          py += hy * (depth + 0.5);
          moved = true;
        }
        if (!moved) break;
      }

      // Vertical: fall / rise, land on the highest walkable surface under the feet (stepping up to `step`).
      const targetZ = pz + dz / steps;
      const g = this.probeGround(px, py, pz + step, radius * 0.4, walkableZ);
      const lowest = dz <= 0 ? targetZ - snap : targetZ;
      if (g && g.z >= lowest - 1 && g.z <= pz + step + 1) {
        pz = g.z;
        grounded = true;
        ground = g;
      } else {
        // Ceiling: stop the head at the first surface above it.
        if (dz > 0) {
          const ceiling = this.probeCeiling(px, py, pz + height, targetZ + height, walkableZ);
          pz = ceiling === null ? targetZ : Math.max(pz, ceiling - height - 1);
        } else pz = targetZ;
        grounded = false;
        ground = null;
      }
    }
    if (ground) ground = { ...ground, z: ground.z + gz };
    return { position: [px + gx, py + gy, pz + gz], grounded, ground };
  }

  /** Collect static movement triangles and terrain triangles overlapping an origin-relative box. */
  private gather(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
    const c = this.cand;
    c.clear();
    const out = this.queryOut;
    out.length = 0;
    this.bvh.query(minX, minY, minZ, maxX, maxY, maxZ, TRI_MOVE, out);
    const soup = this.bvh.soup;
    for (const tri of out) {
      const m = soup.materials[tri];
      const f = soup.flags[tri];
      c.push(soup.positions, tri * 9, f & TRI_HULL ? KIND_HULL : f & TRI_THIN ? KIND_THIN : KIND_SOLID, m === NO_MATERIAL ? -1 : m, soup.objects[tri]);
    }
    for (const b of this.bodies) {
      const box = b.box;
      if (!b.enabled || box[0] > maxX || box[3] < minX || box[1] > maxY || box[4] < minY || box[2] > maxZ || box[5] < minZ) continue;
      this.gatherBody(b, b.matrix, minX, minY, minZ, maxX, maxY, maxZ);
    }
    const terrain = this.terrain;
    if (!terrain) return;
    terrain.forColumns(minX, minY, maxX, maxY, (col) => {
      if (col.maxZ < minZ || col.minZ > maxZ) return;
      const p = col.positions;
      for (let j = 0; j < col.materials.length; j++) {
        const q = j * 9;
        if (Math.max(p[q], p[q + 3], p[q + 6]) < minX || Math.min(p[q], p[q + 3], p[q + 6]) > maxX) continue;
        if (Math.max(p[q + 1], p[q + 4], p[q + 7]) < minY || Math.min(p[q + 1], p[q + 4], p[q + 7]) > maxY) continue;
        if (Math.max(p[q + 2], p[q + 5], p[q + 8]) < minZ || Math.min(p[q + 2], p[q + 5], p[q + 8]) > maxZ) continue;
        c.push(p, q, KIND_SOLID, terrain.gameMaterial(col.materials[j]), -1);
      }
    });
  }

  /** Append a body's movement triangles overlapping an origin-relative box to the candidates, in world space. */
  private gatherBody(b: DynamicBody, m: ArrayLike<number>, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
    // The query box in the body's frame: bounds of its eight corners.
    const lmin = [Infinity, Infinity, Infinity];
    const lmax = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 8; k++) {
      toLocal(m, k & 1 ? maxX : minX, k & 2 ? maxY : minY, k & 4 ? maxZ : minZ, lo);
      for (let j = 0; j < 3; j++) {
        if (lo[j] < lmin[j]) lmin[j] = lo[j];
        if (lo[j] > lmax[j]) lmax[j] = lo[j];
      }
    }
    const out = this.queryOut;
    out.length = 0;
    b.bvh.query(lmin[0], lmin[1], lmin[2], lmax[0], lmax[1], lmax[2], TRI_MOVE, out);
    const soup = b.bvh.soup;
    const p = soup.positions;
    for (const tri of out) {
      for (let k = 0; k < 3; k++) {
        toWorld(m, p[tri * 9 + k * 3], p[tri * 9 + k * 3 + 1], p[tri * 9 + k * 3 + 2], lo);
        tri9[k * 3] = lo[0];
        tri9[k * 3 + 1] = lo[1];
        tri9[k * 3 + 2] = lo[2];
      }
      const mat = soup.materials[tri];
      const f = soup.flags[tri];
      this.cand.push(tri9, 0, f & TRI_HULL ? KIND_HULL : f & TRI_THIN ? KIND_THIN : KIND_SOLID, mat === NO_MATERIAL ? -1 : mat, -1, b.id);
    }
  }

  /** Highest walkable surface of a body under origin-relative (x, y), searching down from `top` by `depth`. */
  private bodyGround(b: DynamicBody, x: number, y: number, top: number, depth: number, walkableZ: number): GroundInfo | null {
    const m = b.matrix;
    toLocal(m, x, y, top, lo);
    dirToLocal(m, 0, 0, -1, ld);
    const soup = b.bvh.soup;
    const n = [0, 0, 0];
    const worldNz = (tri: number) => {
      triangleNormal(soup.positions, tri * 9, n);
      return m[2] * n[0] + m[6] * n[1] + m[10] * n[2];
    };
    const h = b.bvh.raycast(lo[0], lo[1], lo[2], ld[0], ld[1], ld[2], depth, TRI_MOVE, (tri) => Math.abs(worldNz(tri)) >= walkableZ);
    if (!h) return null;
    triangleNormal(soup.positions, h.tri * 9, n);
    dirToWorld(m, n[0], n[1], n[2], n);
    if (n[2] < 0) n[0] = -n[0], n[1] = -n[1], n[2] = -n[2];
    let mat = soup.materials[h.tri];
    if (soup.flags[h.tri] & TRI_HULL) {
      const under = b.bvh.raycast(lo[0] + ld[0] * (h.t - 1), lo[1] + ld[1] * (h.t - 1), lo[2] + ld[2] * (h.t - 1), ld[0], ld[1], ld[2], HULL_MATERIAL_DEPTH, TRI_RAY);
      if (under) mat = soup.materials[under.tri];
    }
    return { z: top - h.t, normal: [n[0], n[1], n[2]], material: mat === NO_MATERIAL ? -1 : mat, object: -1, body: b.id };
  }

  /**
   * Does a character standing at `feet` (absolute) rest on the body when the body is at `matrix`? A short probe down
   * from just above the feet at the centre and four points around it, for walkable surfaces that stand above the
   * static ground there (a door's hull reaching down to the floor it stands on is not a platform).
   */
  supports(b: DynamicBody, matrix: ArrayLike<number>, feet: readonly number[], radius: number): boolean {
    let floor: number | null = null;
    const [gx, gy, gz] = this.origin;
    const above = 0.35 * METRE;
    const below = 0.35 * METRE;
    const spread = radius * 0.4;
    dirToLocal(matrix, 0, 0, -1, ld);
    const soup = b.bvh.soup;
    const n = [0, 0, 0];
    const worldNz = (tri: number) => {
      triangleNormal(soup.positions, tri * 9, n);
      return matrix[2] * n[0] + matrix[6] * n[1] + matrix[10] * n[2];
    };
    for (let k = 0; k < 5; k++) {
      const x = feet[0] - gx + (k === 1 ? spread : k === 2 ? -spread : 0);
      const y = feet[1] - gy + (k === 3 ? spread : k === 4 ? -spread : 0);
      toLocal(matrix, x, y, feet[2] - gz + above, lo);
      const h = b.bvh.raycast(lo[0], lo[1], lo[2], ld[0], ld[1], ld[2], above + below, TRI_MOVE, (tri) => Math.abs(worldNz(tri)) >= DEFAULT_WALKABLE_Z);
      if (!h) continue;
      if (floor === null) {
        const under = this.ground(feet[0], feet[1], feet[2] + 0.05 * METRE, DEFAULT_WALKABLE_Z, false);
        floor = under ? under.z - gz + 0.05 * METRE : -Infinity;
      }
      if (feet[2] - gz + above - h.t > floor) return true;
    }
    return false;
  }

  /**
   * Push a character capsule (feet absolute) horizontally out of the body's movement shape above its step height,
   * away from the surfaces it overlaps (along `motion`, the body's own horizontal motion there, when it sits right on
   * one). Returns the horizontal displacement, or null when there is no overlap. Used when doors swing into characters
   * and vehicles drive into them.
   */
  pushOut(b: DynamicBody, feet: readonly number[], radius: number, height: number, motion: readonly number[]): [number, number] | null {
    const [gx, gy, gz] = this.origin;
    let px = feet[0] - gx, py = feet[1] - gy;
    const pz = feet[2] - gz;
    const box = b.box;
    const margin = radius + 0.5 * METRE;
    if (box[0] > px + margin || box[3] < px - margin || box[1] > py + margin || box[4] < py - margin || box[2] > pz + height || box[5] < pz) return null;
    const c = this.cand;
    c.clear();
    this.gatherBody(b, b.matrix, px - margin, py - margin, pz, px + margin, py + margin, pz + height);
    const step = Math.min(DEFAULT_STEP_HEIGHT, height * 0.5);
    const hullRadius = Math.max(MIN_HULL_RADIUS, radius - HULL_GROWTH);
    const thinRadius = Math.min(radius, THIN_RADIUS);
    const ml = Math.hypot(motion[0], motion[1]);
    let pushed = false;
    for (let iter = 0; iter < 6; iter++) {
      let moved = false;
      for (let i = 0; i < c.n; i++) {
        if (Math.abs(c.normal[i * 3 + 2]) >= DEFAULT_WALKABLE_Z) continue;
        const r = c.kind[i] === KIND_HULL ? hullRadius : c.kind[i] === KIND_THIN ? thinRadius : radius;
        const z0 = pz + step + r;
        const z1 = Math.max(z0, pz + height - r);
        const d = segmentTriangle(px, py, z0, z1, c.pos, i * 9, closest);
        if (d >= r) continue;
        let hx = px - closest[0];
        let hy = py - closest[1];
        const hl = Math.hypot(hx, hy);
        if (hl > 1e-3) {
          hx /= hl;
          hy /= hl;
        } else if (ml > 0) {
          hx = motion[0] / ml;
          hy = motion[1] / ml;
        } else continue;
        px += hx * (r - d + 0.5);
        py += hy * (r - d + 0.5);
        moved = pushed = true;
      }
      if (!moved) break;
    }
    return pushed ? [px + gx - feet[0], py + gy - feet[1]] : null;
  }

  /** Highest walkable candidate surface at or below `top` under the centre and four points `spread` around it. */
  private probeGround(x: number, y: number, top: number, spread: number, walkableZ: number): GroundInfo | null {
    const c = this.cand;
    let best: GroundInfo | null = null;
    let bestKind = KIND_SOLID;
    // Highest real (non-hull) surface, for the material under a hull.
    let real: GroundInfo | null = null;
    for (let k = 0; k < 5; k++) {
      const qx = x + (k === 1 ? spread : k === 2 ? -spread : 0);
      const qy = y + (k === 3 ? spread : k === 4 ? -spread : 0);
      for (let i = 0; i < c.n; i++) {
        const b = i * 6;
        if (c.box[b] > qx || c.box[b + 3] < qx || c.box[b + 1] > qy || c.box[b + 4] < qy || c.box[b + 2] > top) continue;
        const nz = c.normal[i * 3 + 2];
        if (Math.abs(nz) < walkableZ) continue;
        const z = planeZ(c.pos, i * 9, c.normal, i * 3, qx, qy);
        if (z === null || z > top) continue;
        if (c.kind[i] !== KIND_HULL && (!real || z > real.z)) real = { z, normal: [0, 0, 1], material: c.material[i], object: c.object[i], body: c.body[i] };
        if (best && z <= best.z) continue;
        const s = nz < 0 ? -1 : 1;
        best = { z, normal: [c.normal[i * 3] * s, c.normal[i * 3 + 1] * s, nz * s], material: c.material[i], object: c.object[i], body: c.body[i] };
        bestKind = c.kind[i];
      }
    }
    if (best && bestKind === KIND_HULL && real && best.z - real.z <= HULL_MATERIAL_DEPTH) best.material = real.material;
    return best;
  }

  /** Lowest candidate surface between `from` and `to` (z) above (x, y), or null. */
  private probeCeiling(x: number, y: number, from: number, to: number, walkableZ: number): number | null {
    const c = this.cand;
    let best: number | null = null;
    for (let i = 0; i < c.n; i++) {
      const b = i * 6;
      if (c.box[b] > x || c.box[b + 3] < x || c.box[b + 1] > y || c.box[b + 4] < y || c.box[b + 5] < from || c.box[b + 2] > to) continue;
      if (Math.abs(c.normal[i * 3 + 2]) < walkableZ * 0.5) continue;
      const z = planeZ(c.pos, i * 9, c.normal, i * 3, x, y);
      if (z === null || z < from - 1 || z > to) continue;
      if (best === null || z < best) best = z;
    }
    return best;
  }
}

const closest = [0, 0, 0];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * One triangle soup from models' collision sets, transformed by their matrices, with per-triangle query flags (see
 * docs/formats/collision.md, "How open-igi uses it").
 */
function buildSoup(objects: StaticObjectInput[], gameMaterials: GameMaterial[]) {
  let total = 0;
  let skipped = 0;
  for (const o of objects) {
    if (o.collision.modelType === 1) continue;
    total += (o.collision.hit?.faceGroup.length ?? 0) + (o.collision.human?.faceGroup.length ?? 0);
  }
  const positions = new Float32Array(total * 9);
  const materials = new Uint16Array(total);
  const flags = new Uint8Array(total);
  const owners = new Uint32Array(total);
  let n = 0;
  let hitTriangles = 0;
  let hullTriangles = 0;
  objects.forEach((o, index) => {
    // Skinned models' collision is bone-relative; they are characters, not static geometry.
    if (o.collision.modelType === 1) {
      skipped++;
      return;
    }
    const m = o.matrix;
    const hasHull = !!o.collision.human;
    for (const [mesh, isHull] of [[o.collision.hit, false], [o.collision.human, true]] as const) {
      if (!mesh) continue;
      const v = mesh.vertices;
      for (let f = 0; f < mesh.faceGroup.length; f++) {
        for (let k = 0; k < 3; k++) {
          const i = mesh.faces[f * 3 + k] * 3;
          const x = v[i], y = v[i + 1], z = v[i + 2];
          positions[n * 9 + k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          positions[n * 9 + k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          positions[n * 9 + k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        const group = mesh.groups[mesh.faceGroup[f]];
        const material = group.material;
        materials[n] = material;
        owners[n] = index;
        if (isHull) {
          flags[n] = TRI_MOVE | TRI_HULL;
          hullTriangles++;
        } else {
          const info = material === NO_MATERIAL ? undefined : gameMaterials[material];
          let fl = 0;
          // Linked groups are the panes filling a building's window and door openings (no material); the
          // openings stay open to rays and sight, as the doors themselves are separate Door objects.
          const opening = group.link >= 0 && material === NO_MATERIAL;
          if (!info?.passThrough && !opening) fl |= TRI_RAY;
          if (!opening && (!info || (info.transparency <= 0.5 && !info.passThrough))) fl |= TRI_SIGHT;
          // Models without a human hull block movement with their real shape (fences, small buildings). Where a
          // hull exists, the real shape still keeps the capsule's core out (details the coarse hull leaves out,
          // such as furniture inside an open doorway), with a thin radius.
          if (material !== 0 && !opening && !info?.passThrough) fl |= hasHull ? TRI_MOVE | TRI_THIN : TRI_MOVE;
          else if (!hasHull && material !== 0) fl |= TRI_MOVE;
          flags[n] = fl;
          hitTriangles++;
        }
        n++;
      }
    }
  });
  return { soup: { positions, materials, flags, objects: owners }, hitTriangles, hullTriangles, skipped };
}

/**
 * A moving collider: its triangles stay in model space in their own BVH; queries transform into the body's frame.
 * Matrices are rigid (rotation + translation, no scale), column-major, origin-relative like StaticObjectInput.matrix.
 */
export class DynamicBody {
  readonly id: number;
  readonly model: string;
  readonly bvh: TriangleBvh;
  /** Entity whose hits this body reports (doors, vehicles), or null. */
  entityId: number | null;
  /** Disabled bodies take part in no query (a hidden or destroyed object). */
  enabled = true;
  /** Model → origin-relative world. */
  readonly matrix = new Float64Array(16);
  /** The pose at the last carry step (physics moves riders by matrix * inverse(carried)). */
  readonly carried = new Float64Array(16);
  /** World-space bounds (origin-relative): minX, minY, minZ, maxX, maxY, maxZ. */
  readonly box = new Float64Array(6);
  /** World-space bounds at the carry reference pose. */
  readonly oldBox = new Float64Array(6);
  /** Model-space bounds of all triangles: minX, minY, minZ, maxX, maxY, maxZ. */
  readonly localBounds: number[];

  constructor(id: number, model: string, bvh: TriangleBvh, entityId: number | null) {
    this.id = id;
    this.model = model;
    this.bvh = bvh;
    this.entityId = entityId;
    const p = bvh.soup.positions;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < lo[k]) lo[k] = p[i + k];
        if (p[i + k] > hi[k]) hi[k] = p[i + k];
      }
    }
    this.localBounds = [...lo, ...hi];
    this.carried.set(IDENTITY);
  }

  /** Place the body (column-major, origin-relative). The first call also sets the carry reference. */
  setMatrix(m: ArrayLike<number>) {
    const first = this.matrix[15] === 0;
    for (let i = 0; i < 16; i++) this.matrix[i] = m[i];
    boxOf(this.matrix, this.localBounds, this.box);
    if (first) this.settle();
  }

  /** Make the current pose the carry reference (after carrying riders, or when re-enabled). */
  settle() {
    this.carried.set(this.matrix);
    this.oldBox.set(this.box);
  }

  /** Has the body moved since the last carry step? */
  get moved(): boolean {
    for (let i = 0; i < 16; i++) if (this.matrix[i] !== this.carried[i]) return true;
    return false;
  }
}

/** World bounds of a model-space box under a rigid matrix. */
function boxOf(m: ArrayLike<number>, local: number[], out: Float64Array) {
  for (let k = 0; k < 3; k++) {
    let lo = m[12 + k];
    let hi = m[12 + k];
    for (let j = 0; j < 3; j++) {
      const a = m[j * 4 + k] * local[j];
      const b = m[j * 4 + k] * local[3 + j];
      lo += Math.min(a, b);
      hi += Math.max(a, b);
    }
    out[k] = lo;
    out[3 + k] = hi;
  }
}

/** World point → model space under a rigid matrix (transpose of the rotation). */
export function toLocal(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]): number[] {
  const dx = x - m[12], dy = y - m[13], dz = z - m[14];
  out[0] = m[0] * dx + m[1] * dy + m[2] * dz;
  out[1] = m[4] * dx + m[5] * dy + m[6] * dz;
  out[2] = m[8] * dx + m[9] * dy + m[10] * dz;
  return out;
}

/** World direction → model space. */
export function dirToLocal(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]): number[] {
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[4] * x + m[5] * y + m[6] * z;
  out[2] = m[8] * x + m[9] * y + m[10] * z;
  return out;
}

/** Model direction → world. */
export function dirToWorld(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]): number[] {
  const a = m[0] * x + m[4] * y + m[8] * z;
  const b = m[1] * x + m[5] * y + m[9] * z;
  const c = m[2] * x + m[6] * y + m[10] * z;
  out[0] = a;
  out[1] = b;
  out[2] = c;
  return out;
}

/** Does the ray o + t*u, 0 <= t <= tMax, touch the box (minX, minY, minZ, maxX, maxY, maxZ)? */
function rayBox(ox: number, oy: number, oz: number, ux: number, uy: number, uz: number, tMax: number, b: ArrayLike<number>): boolean {
  let t0 = 0;
  let t1 = tMax;
  const o = [ox, oy, oz];
  const u = [ux, uy, uz];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(u[k]) < 1e-12) {
      if (o[k] < b[k] || o[k] > b[3 + k]) return false;
      continue;
    }
    let a = (b[k] - o[k]) / u[k];
    let c = (b[3 + k] - o[k]) / u[k];
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return false;
  }
  return true;
}

const lo = [0, 0, 0];
const ld = [0, 0, 0];
const tri9 = new Float64Array(9);

/** Model point → world. */
export function toWorld(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]): number[] {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** z of the triangle's plane at (x, y) when (x, y) lies inside its x/y projection, else null. */
function planeZ(p: Float64Array, q: number, n: Float64Array, nq: number, x: number, y: number): number | null {
  const ax = p[q], ay = p[q + 1];
  const bx = p[q + 3], by = p[q + 4];
  const cx = p[q + 6], cy = p[q + 7];
  const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const d2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
  const d3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
  const eps = 1e-3 * (Math.abs(bx - ax) + Math.abs(by - ay) + Math.abs(cx - ax) + Math.abs(cy - ay));
  const neg = d1 < -eps || d2 < -eps || d3 < -eps;
  const pos = d1 > eps || d2 > eps || d3 > eps;
  if (neg && pos) return null;
  const nz = n[nq + 2];
  if (Math.abs(nz) < 1e-9) return null;
  return p[q + 2] - (n[nq] * (x - ax) + n[nq + 1] * (y - ay)) / nz;
}

/**
 * Distance between the vertical segment (x, y, z0..z1) and the triangle at p[q..q+9]; the closest point on the
 * triangle goes to `out`.
 */
export function segmentTriangle(x: number, y: number, z0: number, z1: number, p: ArrayLike<number>, q: number, out: number[]): number {
  let best = Infinity;
  const tmp = [0, 0, 0];
  const consider = (sx: number, sy: number, sz: number, tx: number, ty: number, tz: number) => {
    const d = Math.hypot(sx - tx, sy - ty, sz - tz);
    if (d < best) {
      best = d;
      out[0] = tx;
      out[1] = ty;
      out[2] = tz;
    }
  };
  // Segment crossing the triangle.
  if (z1 > z0) {
    const t = rayTriangleVertical(p, q, x, y, z0, z1);
    if (t !== null) {
      out[0] = x;
      out[1] = y;
      out[2] = t;
      return 0;
    }
  }
  // Endpoints against the triangle.
  closestPointTriangle(x, y, z0, p, q, tmp);
  consider(x, y, z0, tmp[0], tmp[1], tmp[2]);
  if (z1 > z0) {
    closestPointTriangle(x, y, z1, p, q, tmp);
    consider(x, y, z1, tmp[0], tmp[1], tmp[2]);
    // Segment against each edge.
    for (let e = 0; e < 3; e++) {
      const a = q + e * 3;
      const b = q + ((e + 1) % 3) * 3;
      const r = segmentSegment(x, y, z0, z1, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2]);
      consider(x, y, r.sz, r.tx, r.ty, r.tz);
    }
  }
  return best;
}

/** z where the vertical line through (x, y) crosses the triangle, if within z0..z1. */
function rayTriangleVertical(p: ArrayLike<number>, q: number, x: number, y: number, z0: number, z1: number): number | null {
  const ax = p[q], ay = p[q + 1], az = p[q + 2];
  const bx = p[q + 3], by = p[q + 4], bz = p[q + 5];
  const cx = p[q + 6], cy = p[q + 7], cz = p[q + 8];
  const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(det) < 1e-9) return null;
  const u = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / det;
  const v = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / det;
  if (u < 0 || v < 0 || u + v > 1) return null;
  const z = az + u * (bz - az) + v * (cz - az);
  return z >= z0 && z <= z1 ? z : null;
}

/** Closest point on triangle p[q..q+9] to (px, py, pz) (Ericson, Real-Time Collision Detection 5.1.5). */
function closestPointTriangle(px: number, py: number, pz: number, p: ArrayLike<number>, q: number, out: number[]) {
  const ax = p[q], ay = p[q + 1], az = p[q + 2];
  const abx = p[q + 3] - ax, aby = p[q + 4] - ay, abz = p[q + 5] - az;
  const acx = p[q + 6] - ax, acy = p[q + 7] - ay, acz = p[q + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const set = (u: number, v: number) => {
    out[0] = ax + abx * u + acx * v;
    out[1] = ay + aby * u + acy * v;
    out[2] = az + abz * u + acz * v;
  };
  if (d1 <= 0 && d2 <= 0) return set(0, 0);
  const bpx = px - p[q + 3], bpy = py - p[q + 4], bpz = pz - p[q + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(d1 / (d1 - d3), 0);
  const cpx = px - p[q + 6], cpy = py - p[q + 7], cpz = pz - p[q + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = p[q + 3] + (p[q + 6] - p[q + 3]) * w;
    out[1] = p[q + 4] + (p[q + 7] - p[q + 4]) * w;
    out[2] = p[q + 5] + (p[q + 8] - p[q + 5]) * w;
    return;
  }
  const denom = 1 / (va + vb + vc);
  set(vb * denom, vc * denom);
}

const segOut = { sz: 0, tx: 0, ty: 0, tz: 0 };

/** Closest points between the vertical segment (x, y, z0..z1) and segment a..b. */
function segmentSegment(x: number, y: number, z0: number, z1: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  // Ericson 5.1.9 with d1 = (0, 0, h).
  const h = z1 - z0;
  const d2x = bx - ax, d2y = by - ay, d2z = bz - az;
  const rx = x - ax, ry = y - ay, rz = z0 - az;
  const a = h * h;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number;
  let t: number;
  if (e <= 1e-12) {
    t = 0;
    s = a > 0 ? clamp01(-(h * rz) / a) : 0;
  } else {
    const c = h * rz;
    const b = h * d2z;
    const denom = a * e - b * b;
    s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
    t = (b * s + f) / e;
    if (t < 0) {
      t = 0;
      s = a > 0 ? clamp01(-c / a) : 0;
    } else if (t > 1) {
      t = 1;
      s = a > 0 ? clamp01((b - c) / a) : 0;
    }
  }
  segOut.sz = z0 + h * s;
  segOut.tx = ax + d2x * t;
  segOut.ty = ay + d2y * t;
  segOut.tz = az + d2z * t;
  return segOut;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
