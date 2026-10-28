// Static triangle soup with a bounding volume hierarchy: built once per level from the placed models' collision
// meshes, then queried by rays (bullets, sight, ground probes) and boxes (character movement).
//
// Coordinates are origin-relative IGI units (see CollisionWorld) so float32 storage keeps sub-millimetre precision.

/** Per-triangle flags: which queries a triangle takes part in. */
export const TRI_RAY = 1; // stops bullets and generic rays
export const TRI_SIGHT = 2; // blocks line of sight
export const TRI_MOVE = 4; // blocks character movement
export const TRI_HULL = 8; // part of a model's human hull (already grown by a person's radius)
export const TRI_THIN = 16; // a hulled model's real shape: blocks movement only within a few centimetres

export interface TriangleSoup {
  /** 9 floats per triangle (three xyz corners). */
  positions: Float32Array;
  /** Game material id per triangle (0xFFFF = none). */
  materials: Uint16Array;
  flags: Uint8Array;
  /** Index into the world's object list (placement) per triangle. */
  objects: Uint32Array;
}

export interface BvhHit {
  t: number;
  tri: number;
}

const LEAF_SIZE = 4;

export class TriangleBvh {
  readonly soup: TriangleSoup;
  readonly count: number;
  /** Per node: minX, minY, minZ, maxX, maxY, maxZ. */
  private bounds: Float32Array;
  /** Per node: inner → right child index (left is node + 1); leaf → -(first + 1). */
  private links: Int32Array;
  /** Per node: leaf triangle count (0 for inner nodes). */
  private counts: Uint16Array;
  /** Triangle order referenced by leaves. */
  private order: Uint32Array;
  private nodeCount = 0;
  private stack: Int32Array<ArrayBuffer> = new Int32Array(128);

  constructor(soup: TriangleSoup) {
    this.soup = soup;
    this.count = soup.flags.length;
    const n = Math.max(1, this.count);
    this.bounds = new Float32Array(n * 2 * 6);
    this.links = new Int32Array(n * 2);
    this.counts = new Uint16Array(n * 2);
    this.order = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) this.order[i] = i;
    if (!this.count) {
      this.bounds.set([1, 1, 1, -1, -1, -1]);
      this.nodeCount = 1;
      this.counts[0] = 0;
      this.links[0] = -1;
      return;
    }
    // Triangle bounds and centroids, once.
    const box = new Float32Array(this.count * 6);
    const centre = new Float32Array(this.count * 3);
    const p = soup.positions;
    for (let i = 0; i < this.count; i++) {
      for (let k = 0; k < 3; k++) {
        const a = p[i * 9 + k];
        const b = p[i * 9 + 3 + k];
        const c = p[i * 9 + 6 + k];
        const lo = Math.min(a, b, c);
        const hi = Math.max(a, b, c);
        box[i * 6 + k] = lo;
        box[i * 6 + 3 + k] = hi;
        centre[i * 3 + k] = (lo + hi) / 2;
      }
    }
    this.build(0, this.count, box, centre);
  }

  /** Recursive median split on the longest centroid axis. Returns the node index. */
  private build(start: number, end: number, box: Float32Array, centre: Float32Array): number {
    const node = this.nodeCount++;
    const b = this.bounds;
    const o = node * 6;
    b[o] = b[o + 1] = b[o + 2] = Infinity;
    b[o + 3] = b[o + 4] = b[o + 5] = -Infinity;
    const clo = [Infinity, Infinity, Infinity];
    const chi = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = this.order[i];
      for (let k = 0; k < 3; k++) {
        b[o + k] = Math.min(b[o + k], box[t * 6 + k]);
        b[o + 3 + k] = Math.max(b[o + 3 + k], box[t * 6 + 3 + k]);
        clo[k] = Math.min(clo[k], centre[t * 3 + k]);
        chi[k] = Math.max(chi[k], centre[t * 3 + k]);
      }
    }
    const n = end - start;
    const extent = [chi[0] - clo[0], chi[1] - clo[1], chi[2] - clo[2]];
    const axis = extent[0] >= extent[1] && extent[0] >= extent[2] ? 0 : extent[1] >= extent[2] ? 1 : 2;
    if (n <= LEAF_SIZE || extent[axis] <= 0) {
      this.links[node] = -(start + 1);
      this.counts[node] = n;
      return node;
    }
    const mid = (start + end) >> 1;
    selectNth(this.order, start, end - 1, mid, (t) => centre[t * 3 + axis]);
    this.build(start, mid, box, centre);
    this.links[node] = this.build(mid, end, box, centre);
    this.counts[node] = 0;
    return node;
  }

  /**
   * Nearest triangle hit by the ray o + t*d, 0 <= t <= tMax, among triangles with any of `mask`'s flags and
   * accepted by `filter` (if given). Triangles are two-sided.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number, mask: number, filter?: (tri: number) => boolean): BvhHit | null {
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const b = this.bounds;
    const p = this.soup.positions;
    const flags = this.soup.flags;
    let best = tMax;
    let bestTri = -1;
    let stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp];
      const o = node * 6;
      // Slab test.
      let t0 = 0;
      let t1 = best;
      let a = (b[o] - ox) * ix;
      let c = (b[o + 3] - ox) * ix;
      if (a > c) [a, c] = [c, a];
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      a = (b[o + 1] - oy) * iy;
      c = (b[o + 4] - oy) * iy;
      if (a > c) [a, c] = [c, a];
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      a = (b[o + 2] - oz) * iz;
      c = (b[o + 5] - oz) * iz;
      if (a > c) [a, c] = [c, a];
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1 || t1 !== t1) continue; // miss (or NaN from 0 * Infinity on a degenerate slab)
      const link = this.links[node];
      if (link >= 0) {
        if (sp + 2 > stack.length) stack = this.stack = growStack(stack);
        stack[sp++] = link;
        stack[sp++] = node + 1;
        continue;
      }
      const first = -link - 1;
      const end = first + this.counts[node];
      for (let i = first; i < end; i++) {
        const tri = this.order[i];
        if (!(flags[tri] & mask)) continue;
        const t = rayTriangle(p, tri * 9, ox, oy, oz, dx, dy, dz);
        if (t >= 0 && t < best && (!filter || filter(tri))) {
          best = t;
          bestTri = tri;
        }
      }
    }
    return bestTri < 0 ? null : { t: best, tri: bestTri };
  }

  /** Append to `out` every triangle with any of `mask`'s flags whose bounds overlap the box. */
  query(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, mask: number, out: number[]) {
    const b = this.bounds;
    const p = this.soup.positions;
    const flags = this.soup.flags;
    let stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp];
      const o = node * 6;
      if (b[o] > maxX || b[o + 3] < minX || b[o + 1] > maxY || b[o + 4] < minY || b[o + 2] > maxZ || b[o + 5] < minZ) continue;
      const link = this.links[node];
      if (link >= 0) {
        if (sp + 2 > stack.length) stack = this.stack = growStack(stack);
        stack[sp++] = link;
        stack[sp++] = node + 1;
        continue;
      }
      const first = -link - 1;
      const end = first + this.counts[node];
      for (let i = first; i < end; i++) {
        const tri = this.order[i];
        if (!(flags[tri] & mask)) continue;
        const q = tri * 9;
        if (Math.min(p[q], p[q + 3], p[q + 6]) > maxX || Math.max(p[q], p[q + 3], p[q + 6]) < minX) continue;
        if (Math.min(p[q + 1], p[q + 4], p[q + 7]) > maxY || Math.max(p[q + 1], p[q + 4], p[q + 7]) < minY) continue;
        if (Math.min(p[q + 2], p[q + 5], p[q + 8]) > maxZ || Math.max(p[q + 2], p[q + 5], p[q + 8]) < minZ) continue;
        out.push(tri);
      }
    }
  }
}

function growStack(s: Int32Array): Int32Array<ArrayBuffer> {
  const n = new Int32Array(s.length * 2);
  n.set(s);
  return n;
}

/** Quickselect: reorder a[lo..hi] so a[k] holds the k-th smallest key, smaller keys before it, larger after. */
function selectNth(a: Uint32Array, lo: number, hi: number, k: number, key: (v: number) => number) {
  while (hi > lo) {
    const pivot = key(a[(lo + hi) >> 1]);
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (key(a[i]) < pivot) i++;
      while (key(a[j]) > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

/** Möller–Trumbore, two-sided. Returns t (in units of d) or -1. Triangle corners at p[q..q+9]. */
export function rayTriangle(p: ArrayLike<number>, q: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const ax = p[q], ay = p[q + 1], az = p[q + 2];
  const e1x = p[q + 3] - ax, e1y = p[q + 4] - ay, e1z = p[q + 5] - az;
  const e2x = p[q + 6] - ax, e2y = p[q + 7] - ay, e2z = p[q + 8] - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : -1;
}

/** Unit normal of the triangle at p[q..q+9] into out (orientation as stored). */
export function triangleNormal(p: ArrayLike<number>, q: number, out: number[]): number[] {
  const e1x = p[q + 3] - p[q], e1y = p[q + 4] - p[q + 1], e1z = p[q + 5] - p[q + 2];
  const e2x = p[q + 6] - p[q], e2y = p[q + 7] - p[q + 1], e2z = p[q + 8] - p[q + 2];
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / l;
  out[1] = ny / l;
  out[2] = nz / l;
  return out;
}
