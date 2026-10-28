// Build a textured terrain mesh around a viewpoint by walking the .ctr cube octree.
//
// The world is one root cube of half-size 2^30 centred on the origin (ctr record 1). A cube at level L has
// half-size 2^(30-L); leaves are level 16 (about 8 m across). Every cube carries its own mesh, so any level can
// stand in for its subtree. Children reuse shared subtrees under one of 8 rotate/mirror transforms.
//
// Level tasks (TextureModifier, TerrainLightMap, HeightMap) attach to the cube at their level containing their
// position. Walking down the tree pushes each cube's tasks on a stack; the deepest task wins.
//
// Texturing matches the original renderer: per vertex, a material comes from up to four texture-modifier
// bitmaps. Each material in a cube draws a near texture (tex1) and a far texture (tex2), picked from 8x8 tile
// maps by world position and cross-faded by distance. The first material's near texture is the opaque base
// layer; every other (material, texture) is added on top with per-vertex weights that sum to 1. A greyscale
// lightmap multiplies the result.
//
// Conventions, tables and formulas follow hjcminus/Project-IGI-Terrain (MIT); see THIRD_PARTY.md.

import { readCmd, type CtrNode, type TerrainMaterials } from "../formats/terrain.ts";

interface CubeTask {
  level: number;
  min: [number, number, number];
}

export interface HeightPatch extends CubeTask {
  size: number;
  heights: Uint8Array;
}

export interface TextureModifier extends CubeTask {
  material: number;
  size: number;
  bits: Uint8Array;
}

export interface LightMapRef extends CubeTask {
  size: number;
  index: number;
}

export interface TerrainData {
  ctr: CtrNode[];
  cmd: Uint8Array;
  patches: HeightPatch[];
  modifiers: TextureModifier[];
  lightMaps: LightMapRef[];
  /** DiscardTerrain cubes: skipped with their subtree, as the engine does when it walks down into them. */
  discards?: CubeTask[];
  materials: TerrainMaterials;
}

/** Where each lightmap sits in a packed atlas, in atlas pixels. */
export interface LightMapAtlas {
  width: number;
  height: number;
  rects: { x: number; y: number }[];
  /** A pixel that is fully lit, for cubes without a lightmap. */
  white: [number, number];
}

export interface TerrainLayer {
  /** xyz relative to the build origin. */
  positions: Float32Array;
  uvs: Float32Array;
  /** Per-vertex blend weight. */
  alpha: Float32Array;
  /** Per-vertex index into terrain.tex. */
  texture: Float32Array;
  indices: Uint32Array;
}

export interface TerrainMesh {
  base: TerrainLayer;
  blend: TerrainLayer;
  /** Lightmap pass: positions and atlas UVs (alpha/texture unused). */
  light: TerrainLayer;
  cubes: number;
}

export interface BuildOptions {
  /** Viewpoint in world units; drives level of detail and near/far texture blending. */
  view: [number, number, number];
  radius: number;
  minLevel: number;
  /** Level-of-detail multiplier: 1 matches the original game; higher keeps fine cubes further out. */
  detail: number;
  origin: [number, number, number];
  atlas: LightMapAtlas;
}

export const ROOT_HALF = 2 ** 30;
export const LEAF_LEVEL = 16;
const MIN_PATCH_LEVEL = 14;
// The engine's LOD constants: a cube splits when the view is within CUBE_ACTIVE * 2^(25-L) (Chebyshev distance).
const CUBE_ACTIVE = 163;
const MERGE_DELTA = 64;
const MORPH_START = (CUBE_ACTIVE + MERGE_DELTA) / (CUBE_ACTIVE - MERGE_DELTA);

// Child slot k's octant: x fastest, then y, then z (slot 0 = -x -y -z).
export const OCTANT = Array.from({ length: 8 }, (_, k) => [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1]);

// For a cube under transform t, which stored child fills octant k: CHILD_FOR_OCTANT[t*8 + k].
export const CHILD_FOR_OCTANT = [
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
export const COMPOSE = [
  0, 1, 2, 3, 4, 5, 6, 7,
  1, 2, 3, 0, 5, 6, 7, 4,
  2, 3, 0, 1, 6, 7, 4, 5,
  3, 0, 1, 2, 7, 4, 5, 6,
  4, 7, 6, 5, 0, 3, 2, 1,
  5, 4, 7, 6, 1, 0, 3, 2,
  6, 5, 4, 7, 2, 1, 0, 3,
  7, 6, 5, 4, 3, 2, 1, 0,
];

const NO_MATERIAL = 255;

/** The cube at `level` containing a point: its min corner. */
export function cubeMinAt(p: [number, number, number], level: number): [number, number, number] {
  const size = 2 * (ROOT_HALF / 2 ** level);
  return p.map((v) => Math.floor(v / size) * size) as [number, number, number];
}

const cubeKey = (level: number, min: readonly number[]) => `${level},${min[0]},${min[1]},${min[2]}`;

/** Keys (level,minX,minY,minZ) of the DiscardTerrain cubes. */
export function discardedCubes(data: TerrainData): Set<string> {
  return new Set((data.discards ?? []).map((d) => cubeKey(d.level, d.min)));
}

class LayerBuilder {
  positions: number[] = [];
  uvs: number[] = [];
  alpha: number[] = [];
  texture: number[] = [];
  indices: number[] = [];

  finish(): TerrainLayer {
    return {
      positions: new Float32Array(this.positions),
      uvs: new Float32Array(this.uvs),
      alpha: new Float32Array(this.alpha),
      texture: new Float32Array(this.texture),
      indices: new Uint32Array(this.indices),
    };
  }
}

export function buildTerrain(data: TerrainData, opts: BuildOptions): TerrainMesh {
  const base = new LayerBuilder();
  const blend = new LayerBuilder();
  const light = new LayerBuilder();
  let cubes = 0;
  const [ox, oy, oz] = opts.origin;
  const [vx, vy, vz] = opts.view;

  // Tasks per cube, in script order.
  const tasks = new Map<string, { patches: HeightPatch[]; modifiers: TextureModifier[]; lightMaps: LightMapRef[] }>();
  const slot = (t: CubeTask) => {
    const key = cubeKey(t.level, t.min);
    let s = tasks.get(key);
    if (!s) tasks.set(key, (s = { patches: [], modifiers: [], lightMaps: [] }));
    return s;
  };
  for (const p of data.patches) slot(p).patches.push(p);
  for (const m of data.modifiers) slot(m).modifiers.push(m);
  for (const l of data.lightMaps) slot(l).lightMaps.push(l);
  const discarded = discardedCubes(data);

  // Distances are divided by the detail multiplier, which scales every LOD threshold together.
  const wantedLevel = (dist: number) =>
    Math.max(opts.minLevel, Math.min(LEAF_LEVEL, Math.ceil(25 - Math.log2(Math.max(dist / opts.detail, 1) / CUBE_ACTIVE))));

  interface Stacks {
    patch: HeightPatch | null;
    lightMap: LightMapRef | null;
    /** Innermost first, at most four. */
    modifiers: TextureModifier[];
  }

  // Within one cube the engine chains tasks newest-first and pushes them in chain order, so the first task in
  // script order ends up on top of the stack.
  function enter(stacks: Stacks, level: number, min: number[]): Stacks {
    const s = tasks.get(cubeKey(level, min));
    if (!s) return stacks;
    return {
      patch: s.patches[0] ?? stacks.patch,
      lightMap: s.lightMaps[0] ?? stacks.lightMap,
      modifiers: s.modifiers.length ? [...s.modifiers, ...stacks.modifiers].slice(0, 4) : stacks.modifiers,
    };
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

  function emit(node: CtrNode, c: [number, number, number], level: number, t: number, stacks: Stacks) {
    const mesh = readCmd(data.cmd, node.cmdOffset);
    if (!mesh.triangles.length) return;
    cubes++;
    const n = mesh.vertices.length;
    const parentCount = n - countChildren(data.cmd, node.cmdOffset);
    const scale = 2 ** (27 - level) / 3;
    const half = ROOT_HALF / 2 ** level;
    const patch = level >= MIN_PATCH_LEVEL ? stacks.patch : null;

    // World positions, cube-local offsets, parent links, morph factors and materials.
    const wx = new Float64Array(n);
    const wy = new Float64Array(n);
    const wz = new Float64Array(n);
    const ref = new Uint8Array(n);
    const factor = new Float32Array(n);
    const mat = new Uint8Array(n);
    const refMat = new Uint8Array(n);
    let used = 0;
    for (let i = 0; i < n; i++) {
      const v = mesh.vertices[i];
      const sx = (v >>> 26) & 63;
      const sy = (v >>> 20) & 63;
      let x = sx - 24;
      let y = sy - 24;
      const z = ((v >>> 14) & 63) - 24;
      if (t & 4) x = 24 - sx;
      if (t & 1) {
        if (t & 2) x = -x;
        else y = 24 - sy;
        [x, y] = [y, x];
      } else if (t & 2) {
        x = -x;
        y = 24 - sy;
      }
      wx[i] = x * scale + c[0];
      wy[i] = y * scale + c[1];
      wz[i] = z * scale + c[2];
      if (patch) wz[i] += patchDelta(patch, wx[i], wy[i]);
      ref[i] = i < parentCount ? i : v & 63;
      if (i < parentCount) {
        const d = Math.max(Math.abs(wx[i] - vx), Math.abs(wy[i] - vy), Math.abs(wz[i] - vz)) / opts.detail;
        factor[i] = Math.min(1, Math.max(0, d / (2 ** (25 - level) * (CUBE_ACTIVE - MERGE_DELTA)) - MORPH_START));
      } else {
        factor[i] = factor[ref[i]];
      }
      mat[i] = materialAt(stacks.modifiers, wx[i], wy[i]);
      refMat[i] = i < parentCount || mat[ref[i]] === mat[i] ? NO_MATERIAL : mat[ref[i]];
      used |= 1 << mat[i];
    }

    // Geomorph: child vertices slide onto their parent vertex as the cube approaches merging (factor 1), so
    // neighbouring cubes at different levels meet without cracks. Materials above use the unmorphed positions.
    for (let i = parentCount; i < n; i++) {
      const f = factor[i];
      const r = ref[i];
      wx[i] += (wx[r] - wx[i]) * f;
      wy[i] += (wy[r] - wy[i]) * f;
      wz[i] += (wz[r] - wz[i]) * f;
    }

    const triangles: number[] = [];
    for (const tri of mesh.triangles) {
      const b0 = tri & 0xff;
      const b1 = (tri >>> 8) & 0xff;
      const b2 = (tri >>> 16) & 0xff;
      if (t & 4) triangles.push(b1, b0, b2);
      else triangles.push(b2, b0, b1);
    }

    const pushLayer = (out: LayerBuilder, texture: number, uv: Float32Array, alpha: Float32Array) => {
      const first = out.positions.length / 3;
      for (let i = 0; i < n; i++) {
        out.positions.push(wx[i] - ox, wy[i] - oy, wz[i] - oz);
        out.uvs.push(uv[i * 2], uv[i * 2 + 1]);
        out.alpha.push(alpha[i]);
        out.texture.push(texture);
      }
      for (const k of triangles) out.indices.push(first + k);
    };

    let layerIndex = 0;
    for (let m = 0; m < 32; m++) {
      if (!(used & (1 << m))) continue;
      const settings = data.materials.materials[m]?.[level];
      if (!settings) continue;
      const tex1 = tileTexture(data.materials.tileMaps[settings.tileMap1], settings.freq1, 22 - level, c);
      const tex2 = tileTexture(data.materials.tileMaps[settings.tileMap2], settings.freq2, 23 - level, c);
      const uv1 = new Float32Array(n * 2);
      const uv2 = new Float32Array(n * 2);
      const a1 = new Float32Array(n);
      const a2 = new Float32Array(n);
      const o1 = tileOffset(settings.freq1, 22 - level, c);
      const o2 = tileOffset(settings.freq2, 23 - level, c);
      const f1 = settings.freq1 / half;
      const f2 = (settings.freq2 * 0.5) / half;
      for (let i = 0; i < n; i++) {
        const v = mesh.vertices[i];
        const lx = wx[i] - c[0];
        const ly = wy[i] - c[1];
        const lz = wz[i] - c[2];
        // Steep faces (projection bits set) map texture v to height, and u to x or y depending on orientation.
        const project = (bits: number, f: number, o: number[], out: Float32Array) => {
          if (bits) {
            out[i * 2] = ((t ^ bits) & 1 ? ly * f + o[1] : lx * f + o[0]);
            out[i * 2 + 1] = lz * f + o[2];
          } else {
            out[i * 2] = lx * f + o[0];
            out[i * 2 + 1] = ly * f + o[1];
          }
        };
        project((v >>> 8) & 3, f1, o1, uv1);
        project((v >>> 6) & 3, f2, o2, uv2);
        // Blend weights at the morph factor f (0 = fully split, 1 = merged into the parent).
        const f = factor[i];
        const d = 1 - f;
        const d2 = d * d;
        if (m === refMat[i]) {
          a1[i] = d - d2;
          a2[i] = d2 + f - d;
        } else if (m === mat[i]) {
          if (refMat[i] !== NO_MATERIAL) {
            a1[i] = d2;
            a2[i] = d - d2;
          } else {
            a1[i] = d;
            a2[i] = f;
          }
        }
      }
      pushLayer(layerIndex === 0 ? base : blend, tex1, uv1, a1);
      if (a2.some((x) => x > 0)) pushLayer(blend, tex2, uv2, a2);
      layerIndex++;
    }

    // Lightmap pass.
    const lm = stacks.lightMap;
    const luv = new Float32Array(n * 2);
    if (lm) {
      const rect = opts.atlas.rects[lm.index];
      const cubeSize = 2 * (ROOT_HALF / 2 ** lm.level);
      for (let i = 0; i < n; i++) {
        const px = Math.max(0.5, Math.min(lm.size - 0.5, ((wx[i] - lm.min[0]) / cubeSize) * lm.size + 0.5));
        const py = Math.max(0.5, Math.min(lm.size - 0.5, ((wy[i] - lm.min[1]) / cubeSize) * lm.size + 0.5));
        luv[i * 2] = (rect.x + px) / opts.atlas.width;
        luv[i * 2 + 1] = (rect.y + py) / opts.atlas.height;
      }
    } else {
      for (let i = 0; i < n; i++) {
        luv[i * 2] = (opts.atlas.white[0] + 0.5) / opts.atlas.width;
        luv[i * 2 + 1] = (opts.atlas.white[1] + 0.5) / opts.atlas.height;
      }
    }
    pushLayer(light, 0, luv, new Float32Array(n));
  }

  function walk(index: number, c: [number, number, number], level: number, t: number, parent: Stacks) {
    const node = data.ctr[index];
    const half = ROOT_HALF / 2 ** level;
    const min = [c[0] - half, c[1] - half, c[2] - half];
    if (discarded.has(cubeKey(level, min))) return;
    const stacks = enter(parent, level, min);
    const dx = Math.max(0, Math.abs(c[0] - vx) - half);
    const dy = Math.max(0, Math.abs(c[1] - vy) - half);
    if (Math.hypot(dx, dy) > opts.radius) return;
    const dz = Math.max(0, Math.abs(c[2] - vz) - half);
    if (level >= wantedLevel(Math.max(dx, dy, dz)) || node.childMask === 0) {
      if (level >= opts.minLevel) emit(node, c, level, t, stacks);
      return;
    }
    const childHalf = half / 2;
    for (let k = 0; k < 8; k++) {
      const slotIndex = CHILD_FOR_OCTANT[t * 8 + k];
      if (!(node.childMask & (1 << slotIndex))) continue;
      const [sx, sy, sz] = OCTANT[k];
      walk(
        node.children[slotIndex],
        [c[0] + sx * childHalf, c[1] + sy * childHalf, c[2] + sz * childHalf],
        level + 1,
        COMPOSE[t * 8 + node.transforms[slotIndex]],
        stacks,
      );
    }
  }

  walk(1, [0, 0, 0], 0, 0, { patch: null, lightMap: null, modifiers: [] });
  return { base: base.finish(), blend: blend.finish(), light: light.finish(), cubes };
}

function countChildren(cmd: Uint8Array, offset: number): number {
  return cmd[offset + 6] | (cmd[offset + 7] << 8);
}

// C-style (int)(f * p) >> shift, as the engine computes tile coordinates.
const tileCoord = (f: number, p: number, shift: number) => Math.trunc(f * p) >> shift;

function tileTexture(tileMap: number[] | undefined, f: number, shift: number, c: number[]): number {
  const x = ((tileCoord(f, c[0], shift) & 0x7ff) >> 8) & 7;
  const y = ((tileCoord(f, c[1], shift) & 0x7ff) >> 8) & 7;
  return tileMap?.[8 * y + x] ?? 0;
}

function tileOffset(f: number, shift: number, c: number[]): number[] {
  return c.map((p) => ((tileCoord(f, p, shift) & 0xff) + 1) / 256);
}
