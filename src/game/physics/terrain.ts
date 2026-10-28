// Terrain collision at full (leaf, level 16) detail, independent of the renderer's level of detail.
//
// Height queries port the engine's GetZ/RecursiveGetZ: walk the .ctr octree down to the leaf cube under (x, y),
// trying the upper cube of each vertical pair first, rebuild the leaf's mesh with its transform and the deepest height
// patch, and take the plane of the first upward-facing triangle that contains the point. Rays and capsule sweeps use
// the same leaf meshes, gathered per 8 m column (every leaf cube stacked over one x/y cell) and cached.
//
// Walk conventions are shared with src/level/terrain.ts; the GetZ order follows hjcminus/Project-IGI-Terrain
// (MIT, source/level/terrain.cpp), see THIRD_PARTY.md.

import { CHILD_FOR_OCTANT, COMPOSE, discardedCubes, LEAF_LEVEL, OCTANT, ROOT_HALF, type HeightPatch, type TerrainData, type TextureModifier } from "../../level/terrain.ts";
import { rayTriangle } from "./bvh.ts";

const LEAF_SIZE = 2 * (ROOT_HALF / 2 ** LEAF_LEVEL);
/** GetZ visits the octants of a cube in this order: each x/y quadrant's upper cube, then its lower one. */
const GET_Z_ORDER = [4, 0, 5, 1, 6, 2, 7, 3];
/** Keep at most this many cached columns (each ~8 m square); the cache is dropped when it fills. */
const MAX_COLUMNS = 16000;

/** Leaf triangles of one 8 m column, origin-relative. */
export interface TerrainColumn {
  /** 9 floats per triangle, wound so the stored normal faces up. */
  positions: Float32Array;
  /** Terrain material (texture-modifier index) per triangle. */
  materials: Uint8Array;
  minZ: number;
  maxZ: number;
}

export interface TerrainGround {
  z: number;
  /** Upward unit normal. */
  normal: [number, number, number];
  /** Terrain material index (see TerrainCollider.gameMaterial). */
  material: number;
}

interface Stacks {
  patch: HeightPatch | null;
  modifiers: TextureModifier[];
}

interface CubeTasks {
  patches: HeightPatch[];
  modifiers: TextureModifier[];
}

const cubeKey = (level: number, x: number, y: number, z: number) => `${level},${x},${y},${z}`;

export class TerrainCollider {
  private data: TerrainData;
  private origin: [number, number, number];
  private tasks = new Map<string, CubeTasks>();
  /** DiscardTerrain cubes (tunnel mouths, bunkers): no collision inside them. */
  private discarded: Set<string>;
  private columns = new Map<number, TerrainColumn>();
  // Scratch for one leaf mesh (at most 64 vertices: 6-bit indices).
  private vx = new Float64Array(64);
  private vy = new Float64Array(64);
  private vz = new Float64Array(64);
  private vm = new Uint8Array(64);
  private dv: DataView;

  /** `gameMaterials[terrainMaterial]` = game material id (terrain.qvm CreateTerrainMaterial's second argument). */
  readonly gameMaterials: number[];

  constructor(data: TerrainData, origin: [number, number, number], gameMaterials: number[] = []) {
    this.gameMaterials = gameMaterials;
    this.data = data;
    this.origin = origin;
    this.dv = new DataView(data.cmd.buffer, data.cmd.byteOffset, data.cmd.byteLength);
    const slot = (t: { level: number; min: [number, number, number] }) => {
      const key = cubeKey(t.level, t.min[0], t.min[1], t.min[2]);
      let s = this.tasks.get(key);
      if (!s) this.tasks.set(key, (s = { patches: [], modifiers: [] }));
      return s;
    };
    for (const p of data.patches) slot(p).patches.push(p);
    for (const m of data.modifiers) slot(m).modifiers.push(m);
    this.discarded = discardedCubes(data);
  }

  private isDiscarded(level: number, c: number[]): boolean {
    if (!this.discarded.size) return false;
    const half = ROOT_HALF / 2 ** level;
    return this.discarded.has(cubeKey(level, c[0] - half, c[1] - half, c[2] - half));
  }

  /** Game material id of a terrain material (Ground, Snow, ...), or -1 if unknown. */
  gameMaterial(material: number): number {
    return this.gameMaterials[material] ?? this.gameMaterials[0] ?? -1;
  }

  /** As the renderer: the first task in script order of a cube goes on top of the stack. */
  private enter(stacks: Stacks, level: number, c: number[]): Stacks {
    const half = ROOT_HALF / 2 ** level;
    const s = this.tasks.get(cubeKey(level, c[0] - half, c[1] - half, c[2] - half));
    if (!s) return stacks;
    return {
      patch: s.patches[0] ?? stacks.patch,
      modifiers: s.modifiers.length ? [...s.modifiers, ...stacks.modifiers].slice(0, 4) : stacks.modifiers,
    };
  }

  /** Decode a leaf cube's mesh into the scratch vertex arrays (absolute coordinates). Returns the vertex count. */
  private leafVertices(cmdOffset: number, c: number[], t: number, stacks: Stacks): number {
    const dv = this.dv;
    const triangleCount = dv.getUint16(cmdOffset, true);
    const n = dv.getUint16(cmdOffset + 4, true) + dv.getUint16(cmdOffset + 6, true);
    const scale = 2 ** (27 - LEAF_LEVEL) / 3;
    const base = cmdOffset + 8 + triangleCount * 4;
    for (let i = 0; i < n; i++) {
      const v = dv.getUint32(base + i * 4, true);
      const sx = (v >>> 26) & 63;
      const sy = (v >>> 20) & 63;
      let x = sx - 24;
      let y = sy - 24;
      const z = ((v >>> 14) & 63) - 24;
      if (t & 4) x = 24 - sx;
      if (t & 1) {
        if (t & 2) x = -x;
        else y = 24 - sy;
        const s = x;
        x = y;
        y = s;
      } else if (t & 2) {
        x = -x;
        y = 24 - sy;
      }
      const wx = x * scale + c[0];
      const wy = y * scale + c[1];
      this.vx[i] = wx;
      this.vy[i] = wy;
      this.vz[i] = z * scale + c[2] + (stacks.patch ? patchDelta(stacks.patch, wx, wy) : 0);
      this.vm[i] = materialAt(stacks.modifiers, wx, wy);
    }
    return n;
  }

  /** Triangle j of the leaf at cmdOffset as vertex indices, wound counter-clockwise seen from above. */
  private leafTriangle(cmdOffset: number, j: number, t: number): [number, number, number] {
    const tri = this.dv.getUint32(cmdOffset + 8 + j * 4, true);
    const b0 = tri & 0xff;
    const b1 = (tri >>> 8) & 0xff;
    const b2 = (tri >>> 16) & 0xff;
    return t & 4 ? [b1, b0, b2] : [b2, b0, b1];
  }

  /** Terrain surface under (x, y), as the engine's GetZ: the top surface, ignoring any height limit. */
  ground(x: number, y: number): TerrainGround | null {
    return this.getZ(1, 0, 0, 0, 0, 0, { patch: null, modifiers: [] }, x, y);
  }

  private getZ(index: number, cx: number, cy: number, cz: number, level: number, t: number, parent: Stacks, x: number, y: number): TerrainGround | null {
    const node = this.data.ctr[index];
    const c = [cx, cy, cz];
    if (this.isDiscarded(level, c)) return null;
    const stacks = this.enter(parent, level, c);
    if (level === LEAF_LEVEL) {
      const n = this.leafVertices(node.cmdOffset, c, t, stacks);
      const triangleCount = this.dv.getUint16(node.cmdOffset, true);
      const { vx, vy, vz } = this;
      for (let j = 0; j < triangleCount; j++) {
        const [a, b, d] = this.leafTriangle(node.cmdOffset, j, t);
        if (a >= n || b >= n || d >= n) continue;
        // Inside when the point is left of every edge (a small tolerance closes the seams between triangles).
        const e = -1e-6;
        if ((vx[b] - vx[a]) * (y - vy[a]) - (vy[b] - vy[a]) * (x - vx[a]) < e * LEAF_SIZE) continue;
        if ((vx[d] - vx[b]) * (y - vy[b]) - (vy[d] - vy[b]) * (x - vx[b]) < e * LEAF_SIZE) continue;
        if ((vx[a] - vx[d]) * (y - vy[d]) - (vy[a] - vy[d]) * (x - vx[d]) < e * LEAF_SIZE) continue;
        const e1x = vx[b] - vx[a], e1y = vy[b] - vy[a], e1z = vz[b] - vz[a];
        const e2x = vx[d] - vx[a], e2y = vy[d] - vy[a], e2z = vz[d] - vz[a];
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        if (nz <= 0) continue;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        const z = vz[a] - (nx * (x - vx[a]) + ny * (y - vy[a])) / nz;
        return { z, normal: [nx, ny, nz], material: materialAt(stacks.modifiers, x, y) };
      }
      return null;
    }
    if (!node.childMask) return null;
    const childHalf = ROOT_HALF / 2 ** (level + 1);
    for (const k of GET_Z_ORDER) {
      const slot = CHILD_FOR_OCTANT[t * 8 + k];
      if (!(node.childMask & (1 << slot))) continue;
      const [sx, sy, sz] = OCTANT[k];
      const nx = cx + sx * childHalf;
      const ny = cy + sy * childHalf;
      if (x < nx - childHalf || x > nx + childHalf || y < ny - childHalf || y > ny + childHalf) continue;
      const found = this.getZ(node.children[slot], nx, ny, cz + sz * childHalf, level + 1, COMPOSE[t * 8 + node.transforms[slot]], stacks, x, y);
      if (found) return found;
    }
    return null;
  }

  /** The cached leaf triangles of the column containing absolute (x, y). */
  column(ix: number, iy: number): TerrainColumn {
    const key = ix * 0x200000 + iy; // |ix|, |iy| <= 2^15
    let col = this.columns.get(key);
    if (col) return col;
    if (this.columns.size >= MAX_COLUMNS) this.columns.clear();
    const positions: number[] = [];
    const materials: number[] = [];
    const x = (ix + 0.5) * LEAF_SIZE;
    const y = (iy + 0.5) * LEAF_SIZE;
    const [ox, oy, oz] = this.origin;
    const collect = (index: number, cx: number, cy: number, cz: number, level: number, t: number, parent: Stacks) => {
      const node = this.data.ctr[index];
      const c = [cx, cy, cz];
      if (this.isDiscarded(level, c)) return;
      const stacks = this.enter(parent, level, c);
      if (level === LEAF_LEVEL) {
        const n = this.leafVertices(node.cmdOffset, c, t, stacks);
        const triangleCount = this.dv.getUint16(node.cmdOffset, true);
        for (let j = 0; j < triangleCount; j++) {
          const tri = this.leafTriangle(node.cmdOffset, j, t);
          if (tri[0] >= n || tri[1] >= n || tri[2] >= n) continue;
          for (const v of tri) positions.push(this.vx[v] - ox, this.vy[v] - oy, this.vz[v] - oz);
          materials.push(this.vm[tri[0]]);
        }
        return;
      }
      if (!node.childMask) return;
      const childHalf = ROOT_HALF / 2 ** (level + 1);
      for (let k = 0; k < 8; k++) {
        const slot = CHILD_FOR_OCTANT[t * 8 + k];
        if (!(node.childMask & (1 << slot))) continue;
        const [sx, sy, sz] = OCTANT[k];
        const nx = cx + sx * childHalf;
        const ny = cy + sy * childHalf;
        if (x < nx - childHalf || x > nx + childHalf || y < ny - childHalf || y > ny + childHalf) continue;
        collect(node.children[slot], nx, ny, cz + sz * childHalf, level + 1, COMPOSE[t * 8 + node.transforms[slot]], stacks);
      }
    };
    collect(1, 0, 0, 0, 0, 0, { patch: null, modifiers: [] });
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 2; i < positions.length; i += 3) {
      minZ = Math.min(minZ, positions[i]);
      maxZ = Math.max(maxZ, positions[i]);
    }
    col = { positions: new Float32Array(positions), materials: new Uint8Array(materials), minZ, maxZ };
    this.columns.set(key, col);
    return col;
  }

  /**
   * Nearest terrain hit along origin-relative o + t*d (t in 0..tMax), walking the 8 m columns the ray crosses.
   * Returns t, the column and the triangle index within it.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number): { t: number; column: TerrainColumn; tri: number } | null {
    const [gx, gy] = this.origin;
    // Absolute x/y in column units.
    const px = (ox + gx) / LEAF_SIZE;
    const py = (oy + gy) / LEAF_SIZE;
    const ddx = dx / LEAF_SIZE;
    const ddy = dy / LEAF_SIZE;
    let ix = Math.floor(px);
    let iy = Math.floor(py);
    const stepX = ddx > 0 ? 1 : -1;
    const stepY = ddy > 0 ? 1 : -1;
    const tDeltaX = ddx !== 0 ? Math.abs(1 / ddx) : Infinity;
    const tDeltaY = ddy !== 0 ? Math.abs(1 / ddy) : Infinity;
    let tNextX = ddx > 0 ? (ix + 1 - px) * tDeltaX : ddx < 0 ? (px - ix) * tDeltaX : Infinity;
    let tNextY = ddy > 0 ? (iy + 1 - py) * tDeltaY : ddy < 0 ? (py - iy) * tDeltaY : Infinity;
    let tEnter = 0;
    for (let guard = 0; guard < 100000 && tEnter <= tMax; guard++) {
      const tExit = Math.min(tNextX, tNextY, tMax);
      const col = this.column(ix, iy);
      // Ray's z range within this column.
      const z0 = oz + dz * tEnter;
      const z1 = oz + dz * tExit;
      if (col.materials.length && Math.min(z0, z1) <= col.maxZ + 1 && Math.max(z0, z1) >= col.minZ - 1) {
        let best = Infinity;
        let bestTri = -1;
        const n = col.materials.length;
        for (let j = 0; j < n; j++) {
          const t = rayTriangle(col.positions, j * 9, ox, oy, oz, dx, dy, dz);
          if (t >= 0 && t <= tMax && t < best) {
            best = t;
            bestTri = j;
          }
        }
        // A triangle can poke out of its column only at seams; accept hits up to the column exit (plus slack).
        if (bestTri >= 0 && best <= tExit + 1e-6) return { t: best, column: col, tri: bestTri };
      }
      if (tExit >= tMax) break;
      tEnter = tExit;
      if (tNextX < tNextY) {
        ix += stepX;
        tNextX += tDeltaX;
      } else {
        iy += stepY;
        tNextY += tDeltaY;
      }
    }
    return null;
  }

  /** Visit the terrain columns overlapping an origin-relative x/y box. */
  forColumns(minX: number, minY: number, maxX: number, maxY: number, visit: (col: TerrainColumn) => void) {
    const [gx, gy] = this.origin;
    const x0 = Math.floor((minX + gx) / LEAF_SIZE);
    const x1 = Math.floor((maxX + gx) / LEAF_SIZE);
    const y0 = Math.floor((minY + gy) / LEAF_SIZE);
    const y1 = Math.floor((maxY + gy) / LEAF_SIZE);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) visit(this.column(ix, iy));
  }

  /** Build the columns within `radius` of absolute (x, y) ahead of time (about 40 us each). Returns the count. */
  prewarm(x: number, y: number, radius: number): number {
    const r = Math.ceil(radius / LEAF_SIZE);
    const cx = Math.floor(x / LEAF_SIZE);
    const cy = Math.floor(y / LEAF_SIZE);
    let n = 0;
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        if (i * i + j * j > r * r) continue;
        this.column(cx + i, cy + j);
        n++;
      }
    return n;
  }
}

/** Height patch offset at (x, y), bilinear over the patch grid: (h - 64) * 256 units. */
function patchDelta(p: HeightPatch, x: number, y: number): number {
  const cubeSize = 2 * (ROOT_HALF / 2 ** p.level);
  const toCell = p.size / cubeSize;
  const fx = (x - p.min[0]) * toCell;
  const fy = (y - p.min[1]) * toCell;
  const ix = Math.max(0, Math.min(p.size, Math.floor(fx)));
  const iy = Math.max(0, Math.min(p.size, Math.floor(fy)));
  const ix1 = Math.min(p.size, ix + 1);
  const iy1 = Math.min(p.size, iy + 1);
  const tx = fx - ix;
  const ty = fy - iy;
  const row = p.size + 1;
  const h = (i: number, j: number) => p.heights[j * row + i];
  const a = h(ix, iy) + (h(ix1, iy) - h(ix, iy)) * tx;
  const b = h(ix, iy1) + (h(ix1, iy1) - h(ix, iy1)) * tx;
  return (a + (b - a) * ty - 64) * 256;
}

/** Terrain material painted at (x, y): the innermost texture modifier whose bitmap is set there, else 0. */
function materialAt(mods: TextureModifier[], x: number, y: number): number {
  for (const m of mods) {
    const cubeSize = 2 * (ROOT_HALF / 2 ** m.level);
    const scale = (m.size / cubeSize) * ((m.size - 1) / m.size);
    const bx = Math.max(0, Math.min(m.size - 1, Math.floor((x - m.min[0]) * scale)));
    const by = Math.max(0, Math.min(m.size - 1, Math.floor((y - m.min[1]) * scale)));
    if ((m.bits[(by * m.size + bx) >> 3] >> (bx & 7)) & 1) return m.material;
  }
  return 0;
}
