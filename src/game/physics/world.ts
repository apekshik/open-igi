// The static collision world: every placed model's collision sets in one BVH, plus leaf-detail terrain. Pure (no
// three.js, no Game), so tools and tests can build it from level files directly.
//
// Internally everything is relative to `origin` (float32 storage stays sub-millimetre). The public methods take and
// return absolute IGI units.

import { NO_MATERIAL, type ModelCollision } from "../../formats/collision.ts";
import type { TerrainData } from "../../level/terrain.ts";
import { TRI_HULL, TRI_MOVE, TRI_RAY, TRI_SIGHT, TRI_THIN, TriangleBvh, triangleNormal } from "./bvh.ts";
import type { GameMaterial } from "./materials.ts";
import { TerrainCollider } from "./terrain.ts";

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
}

export interface GroundInfo {
  z: number;
  normal: [number, number, number];
  material: number;
  object: number;
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

  clear() {
    this.n = 0;
  }

  push(p: ArrayLike<number>, q: number, kind: number, material: number, object: number) {
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
    this.terrain = options.terrain ? new TerrainCollider(options.terrain, options.origin, options.terrainGameMaterials) : null;

    // Count, then fill the triangle soup.
    let total = 0;
    let skipped = 0;
    for (const o of options.objects) {
      if (o.collision.modelType === 1) continue;
      total += (o.collision.hit?.faceGroup.length ?? 0) + (o.collision.human?.faceGroup.length ?? 0);
    }
    const positions = new Float32Array(total * 9);
    const materials = new Uint16Array(total);
    const flags = new Uint8Array(total);
    const objects = new Uint32Array(total);
    let n = 0;
    let hitTriangles = 0;
    let hullTriangles = 0;
    options.objects.forEach((o, index) => {
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
          objects[n] = index;
          if (isHull) {
            flags[n] = TRI_MOVE | TRI_HULL;
            hullTriangles++;
          } else {
            const info = material === NO_MATERIAL ? undefined : this.materials[material];
            let fl = 0;
            // Linked groups are the panes filling a building's window and door openings (no material); the
            // openings stay open to rays and sight, as the doors themselves are separate Door objects.
            const opening = group.link >= 0 && material === NO_MATERIAL;
            if (!info?.passThrough && !opening) fl |= TRI_RAY;
            if (!opening && (!info || (info.transparency <= 0.5 && !info.passThrough))) fl |= TRI_SIGHT;
            // Models without a human hull block movement with their real shape (fences, small buildings). Where a
            // hull exists, the real shape still keeps the capsule's core out (details the coarse hull leaves out,
            // such as furniture inside an open doorway), with a thin radius.
            // Openings never block: a capsule only fits through door-sized ones (level12's tunnel shells close each
            // end with an opening group, which used to wall off every tunnel joint).
            if (material !== 0 && !opening && !info?.passThrough) fl |= hasHull ? TRI_MOVE | TRI_THIN : TRI_MOVE;
            else if (!hasHull && material !== 0 && !opening) fl |= TRI_MOVE;
            flags[n] = fl;
            hitTriangles++;
          }
          n++;
        }
      }
    });
    this.bvh = new TriangleBvh({ positions, materials, flags, objects });
    this.stats = { objects: options.objects.length - skipped, hitTriangles, hullTriangles, skipped };
  }

  materialName(id: number): string | undefined {
    return id >= 0 ? this.materials[id]?.name : undefined;
  }

  // ---------------------------------------------------------------------------------------------------- rays

  /** Nearest static or terrain hit on the segment from → to among triangles with any of `mask`'s flags. */
  raycast(from: readonly number[], to: readonly number[], mask = TRI_RAY): WorldHit | null {
    const [gx, gy, gz] = this.origin;
    const ox = from[0] - gx, oy = from[1] - gy, oz = from[2] - gz;
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return null;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const s = this.bvh.raycast(ox, oy, oz, ux, uy, uz, len, mask);
    const t = this.terrain?.raycast(ox, oy, oz, ux, uy, uz, s ? s.t : len) ?? null;
    let hit: WorldHit;
    const n = [0, 0, 0];
    if (t) {
      triangleNormal(t.column.positions, t.tri * 9, n);
      hit = { distance: t.t, point: [0, 0, 0], normal: [n[0], n[1], n[2]], material: this.terrain!.gameMaterial(t.column.materials[t.tri]), object: -1 };
    } else if (s) {
      triangleNormal(this.bvh.soup.positions, s.tri * 9, n);
      const m = this.bvh.soup.materials[s.tri];
      hit = { distance: s.t, point: [0, 0, 0], normal: [n[0], n[1], n[2]], material: m === NO_MATERIAL ? -1 : m, object: this.bvh.soup.objects[s.tri] };
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
  ground(x: number, y: number, fromZ = 2 ** 31, walkableZ = 0.3): GroundInfo | null {
    const [gx, gy, gz] = this.origin;
    const top = Math.min(fromZ, 2 ** 31) - gz;
    let best: GroundInfo | null = null;
    const terrain = this.terrain?.ground(x, y);
    if (terrain && terrain.z <= fromZ + 1) best = { z: terrain.z, normal: terrain.normal, material: this.terrain!.gameMaterial(terrain.material), object: -1 };
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
      best = { z: top - s.t + gz, normal: [n[0], n[1], n[2]], material: m === NO_MATERIAL ? -1 : m, object: soup.objects[s.tri] };
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
        if (c.kind[i] !== KIND_HULL && (!real || z > real.z)) real = { z, normal: [0, 0, 1], material: c.material[i], object: c.object[i] };
        if (best && z <= best.z) continue;
        const s = nz < 0 ? -1 : 1;
        best = { z, normal: [c.normal[i * 3] * s, c.normal[i * 3 + 1] * s, nz * s], material: c.material[i], object: c.object[i] };
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
