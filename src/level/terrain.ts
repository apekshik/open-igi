// Build a terrain mesh around a point by walking the .ctr cube octree, picking a level of detail by distance.
//
// The world is one root cube of half-size 2^30 centred on the origin (ctr record 1). A cube at level L has
// half-size 2^(30-L); leaves are level 16 (about 8 m across). Every cube carries its own mesh, so any level can
// stand in for its subtree. Children reuse shared subtrees under one of 8 rotate/mirror transforms.
// Octree conventions follow hjcminus/Project-IGI-Terrain (MIT); see THIRD_PARTY.md.

import { readCmd, type CtrNode } from "../formats/terrain.ts";

export interface HeightPatch {
  /** The cube the patch belongs to: its level and min corner (the patch spans the cube's full width). */
  level: number;
  min: [number, number, number];
  size: number;
  heights: Uint8Array;
}

export interface TerrainData {
  ctr: CtrNode[];
  cmd: Uint8Array;
  patches: HeightPatch[];
}

export interface TerrainMesh {
  /** xyz relative to `origin`. */
  positions: Float32Array;
  indices: Uint32Array;
  cubes: number;
}

const ROOT_HALF = 2 ** 30;
const LEAF_LEVEL = 16;
// Height patches only affect fine cubes, as in the game.
const MIN_PATCH_LEVEL = 14;

// Child slot k's octant: x fastest, then y, then z (slot 0 = -x -y -z).
const OCTANT = Array.from({ length: 8 }, (_, k) => [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1]);

// For a cube under transform t, which stored child fills octant k: CHILD_FOR_OCTANT[t*8 + k].
const CHILD_FOR_OCTANT = [
  0, 1, 2, 3, 4, 5, 6, 7, // identity
  2, 0, 3, 1, 6, 4, 7, 5, // rotate 90 about Z
  3, 2, 1, 0, 7, 6, 5, 4, // rotate 180
  1, 3, 0, 2, 5, 7, 4, 6, // rotate 270
  1, 0, 3, 2, 5, 4, 7, 6, // mirror x
  3, 1, 2, 0, 7, 5, 6, 4, // mirror x, rotate 90
  2, 3, 0, 1, 6, 7, 4, 5, // mirror x, rotate 180
  0, 2, 1, 3, 4, 6, 5, 7, // mirror x, rotate 270
];

// Composition of a parent transform (row) with a child's stored transform (column).
const COMPOSE = [
  0, 1, 2, 3, 4, 5, 6, 7,
  1, 2, 3, 0, 5, 6, 7, 4,
  2, 3, 0, 1, 6, 7, 4, 5,
  3, 0, 1, 2, 7, 4, 5, 6,
  4, 7, 6, 5, 0, 3, 2, 1,
  5, 4, 7, 6, 1, 0, 3, 2,
  6, 5, 4, 7, 2, 1, 0, 3,
  7, 6, 5, 4, 3, 2, 1, 0,
];

export interface BuildOptions {
  centre: [number, number];
  radius: number;
  /** Distance within which leaf cubes are used; each doubling beyond it drops one level. */
  leafDistance: number;
  minLevel: number;
  origin: [number, number, number];
}

export function buildTerrain(data: TerrainData, opts: BuildOptions): TerrainMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  let cubes = 0;
  const [ox, oy, oz] = opts.origin;

  const wantedLevel = (dist: number) => {
    if (dist <= opts.leafDistance) return LEAF_LEVEL;
    return Math.max(opts.minLevel, LEAF_LEVEL - Math.ceil(Math.log2(dist / opts.leafDistance)));
  };

  function patchFor(cx: number, cy: number, cz: number, level: number): HeightPatch | null {
    if (level < MIN_PATCH_LEVEL) return null;
    let best: HeightPatch | null = null;
    for (const p of data.patches) {
      const size = 2 * (ROOT_HALF / 2 ** p.level);
      const inside = cx >= p.min[0] && cx < p.min[0] + size && cy >= p.min[1] && cy < p.min[1] + size && cz >= p.min[2] && cz < p.min[2] + size;
      if (inside && (!best || p.level > best.level)) best = p;
    }
    return best;
  }

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

  function emit(node: CtrNode, cx: number, cy: number, cz: number, level: number, t: number) {
    const mesh = readCmd(data.cmd, node.cmdOffset);
    if (!mesh.triangles.length) return;
    cubes++;
    const scale = 2 ** (27 - level) / 3;
    const patch = patchFor(cx, cy, cz, level);
    const base = positions.length / 3;
    for (const v of mesh.vertices) {
      const sx = (v >>> 26) & 63;
      const sy = (v >>> 20) & 63;
      const sz = (v >>> 14) & 63;
      let x = sx - 24;
      let y = sy - 24;
      const z = sz - 24;
      if (t & 4) x = 24 - sx;
      if (t & 1) {
        if (t & 2) x = -x;
        else y = 24 - sy;
        [x, y] = [y, x];
      } else if (t & 2) {
        x = -x;
        y = 24 - sy;
      }
      const wx = x * scale + cx;
      const wy = y * scale + cy;
      let wz = z * scale + cz;
      if (patch) wz += patchDelta(patch, wx, wy);
      positions.push(wx - ox, wy - oy, wz - oz);
    }
    const mirrored = (t & 4) !== 0;
    for (const tri of mesh.triangles) {
      const b0 = tri & 0xff;
      const b1 = (tri >>> 8) & 0xff;
      const b2 = (tri >>> 16) & 0xff;
      if (mirrored) indices.push(base + b1, base + b0, base + b2);
      else indices.push(base + b2, base + b0, base + b1);
    }
  }

  function walk(index: number, cx: number, cy: number, cz: number, level: number, t: number) {
    const node = data.ctr[index];
    const half = ROOT_HALF / 2 ** level;
    const dx = Math.max(0, Math.abs(cx - opts.centre[0]) - half);
    const dy = Math.max(0, Math.abs(cy - opts.centre[1]) - half);
    const dist = Math.hypot(dx, dy);
    if (dist > opts.radius) return;
    if (level >= wantedLevel(dist) || node.childMask === 0) {
      emit(node, cx, cy, cz, level, t);
      return;
    }
    const childHalf = half / 2;
    for (let k = 0; k < 8; k++) {
      const slot = CHILD_FOR_OCTANT[t * 8 + k];
      if (!(node.childMask & (1 << slot))) continue;
      const [sx, sy, sz] = OCTANT[k];
      walk(
        node.children[slot],
        cx + sx * childHalf,
        cy + sy * childHalf,
        cz + sz * childHalf,
        level + 1,
        COMPOSE[t * 8 + node.transforms[slot]],
      );
    }
  }

  walk(1, 0, 0, 0, 0, 0);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), cubes };
}

/** The cube at `level` containing a point: its min corner. */
export function cubeMinAt(p: [number, number, number], level: number): [number, number, number] {
  const size = 2 * (ROOT_HALF / 2 ** level);
  return p.map((v) => Math.floor(v / size) * size) as [number, number, number];
}
