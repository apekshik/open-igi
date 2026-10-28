// .mef: model. An ILFF file (form "MECO", stored reversed as "OCEM") whose chunks hold render geometry, portals,
// attachments and a collision mesh. Chunk tags are little-endian u32s, so "MESH" reads from disk as "HSEM".
// This reader covers render geometry and, for skinned characters (type 1), the skin weights. See docs/FORMATS.md.

import { parseIlff } from "./ilff.ts";
import type { Skeleton } from "./anim.ts";

export interface MefBatch {
  /** Material slot; selects the model's texture (see docs/FORMATS.md). */
  material: number;
  vertexStart: number;
  vertexCount: number;
  /** Triangle list, already offset by vertexStart. */
  indices: Uint16Array;
}

export interface MefModel {
  /** 0 = rigid object, 1 = skinned character, 3 = static lightmapped geometry. */
  type: number;
  vertexCount: number;
  /** xyz per vertex, in IGI units and axes (Z up). */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  batches: MefBatch[];
  /** Type 1 only: per-vertex bone influences. */
  skin?: MefSkin;
}

/**
 * Skin of a type 1 model. VRTX holds `renderCount` render vertices followed by extra influence records. Every record
 * (render or extra) has one bone, one weight and a position and normal in that bone's bind frame. A render vertex's
 * final position is the weighted sum over its own record plus every extra record whose `target` is that vertex.
 */
export interface MefSkin {
  renderCount: number;
  /** Per record (vertexCount): bone, weight, and the render vertex it adds to (itself for render vertices). */
  bone: Uint8Array;
  weight: Float32Array;
  target: Uint16Array;
}

/** Reverse an on-disk tag ("HSEM") to its readable name ("MESH"). */
export const tagName = (tag: string) => tag.split("").reverse().join("");

export function decodeMef(bytes: Uint8Array): MefModel {
  const file = parseIlff(bytes);
  if (tagName(file.formType) !== "MECO") throw new Error(`not a model (form ${file.formType})`);
  const chunk = (name: string) => file.chunks.find((c) => tagName(c.tag) === name);

  const mesh = chunk("MESH");
  const vrtx = chunk("VRTX");
  const rend = chunk("REND");
  if (!mesh || !vrtx || !rend) throw new Error("model has no render geometry");
  const mv = new DataView(mesh.data.buffer, mesh.data.byteOffset, mesh.length);
  const type = mv.getUint32(32, true);
  const vertexCount = mv.getUint32(100, true);

  // 40 bytes for types 1 and 3 (the last 8 are lightmap UVs or bone data), 32 for type 0.
  const stride = vertexCount ? vrtx.length / vertexCount : 0;
  if (vertexCount && stride !== 32 && stride !== 40) throw new Error(`unexpected vertex stride ${stride}`);
  const vv = new DataView(vrtx.data.buffer, vrtx.data.byteOffset, vrtx.length);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    const at = i * stride;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = vv.getFloat32(at + k * 4, true);
      normals[i * 3 + k] = vv.getFloat32(at + 12 + k * 4, true);
    }
    uvs[i * 2] = vv.getFloat32(at + 24, true);
    uvs[i * 2 + 1] = vv.getFloat32(at + 28, true);
  }

  // REND: back-to-back batches, each a header then indexCount u16 indices relative to vertexStart.
  //   type 3:     vec3 centre, u16 indexCount, u16 ?, u16 material, u16 flags?, u16 vertexStart, u16 vertexCount, u8[8]  (32 bytes)
  //   types 0, 1: vec3 centre, u16 indexCount, u16 ?, u16 material, u16 vertexStart, u16 vertexCount, u8[6]  (28 bytes)
  const wide = type === 3;
  const header = wide ? 32 : 28;
  const rv = new DataView(rend.data.buffer, rend.data.byteOffset, rend.length);
  const batches: MefBatch[] = [];
  let at = 0;
  while (at + header <= rend.length) {
    const indexCount = rv.getUint16(at + 12, true);
    const material = rv.getUint16(at + 16, true);
    const vertexStart = rv.getUint16(at + (wide ? 20 : 18), true);
    const batchVertices = rv.getUint16(at + (wide ? 22 : 20), true);
    at += header;
    if (at + indexCount * 2 > rend.length) throw new Error(`REND batch overruns chunk (${indexCount} indices)`);
    if (vertexStart + batchVertices > vertexCount) throw new Error(`REND batch references vertices past ${vertexCount}`);
    const indices = new Uint16Array(indexCount);
    for (let i = 0; i < indexCount; i++) indices[i] = vertexStart + rv.getUint16(at + i * 2, true);
    batches.push({ material, vertexStart, vertexCount: batchVertices, indices });
    at += indexCount * 2;
  }
  if (at !== rend.length) throw new Error(`REND has ${rend.length - at} trailing bytes`);
  const skin = type === 1 ? readSkin(chunk("RD3D"), vv, vertexCount, stride) : undefined;
  return { type, vertexCount, positions, normals, uvs, batches, skin };
}

// Type 1 vertices end in: f32 weight, u16 index, u8 bone, u8 0. For render vertices the u16 is the vertex's index
// within its REND batch; for the extra records after them it is the (model-wide) render vertex they add to.
// RD3D (56 bytes for type 1): u32 4, triangleCount, batchCount, extraCount, renderCount, vertexCount, zeros.
// The extra-record idea came from heaven-hm/project-igi-converter's notes (see THIRD_PARTY.md).
function readSkin(rd3d: { data: Uint8Array; length: number } | undefined, vv: DataView, count: number, stride: number): MefSkin {
  if (!rd3d || rd3d.length < 24 || stride !== 40) throw new Error("type 1 model without RD3D skin counts");
  const rv = new DataView(rd3d.data.buffer, rd3d.data.byteOffset, rd3d.length);
  const extra = rv.getUint32(12, true);
  const renderCount = rv.getUint32(16, true);
  if (renderCount + extra !== count || rv.getUint32(20, true) !== count) {
    throw new Error(`RD3D vertex counts ${renderCount}+${extra} do not match ${count}`);
  }
  const bone = new Uint8Array(count);
  const weight = new Float32Array(count);
  const target = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    weight[i] = vv.getFloat32(i * 40 + 32, true);
    bone[i] = vv.getUint8(i * 40 + 38);
    target[i] = i < renderCount ? i : vv.getUint16(i * 40 + 36, true);
    if (target[i] >= renderCount) throw new Error(`skin record ${i} targets vertex ${target[i]} of ${renderCount}`);
  }
  return { renderCount, bone, weight, target };
}

/**
 * Pose a type 1 model. `bones` holds 12 floats per bone (row-major 3x3 rotation, then translation), as made by
 * `poseBones` in anim.ts. Returns model-space positions and normals for every render vertex (extra records stay 0).
 */
export function skinMef(model: MefModel, bones: Float32Array): { positions: Float32Array; normals: Float32Array } {
  const skin = model.skin;
  if (!skin) throw new Error("model has no skin");
  const positions = new Float32Array(model.vertexCount * 3);
  const normals = new Float32Array(model.vertexCount * 3);
  const { positions: p, normals: n } = model;
  for (let i = 0; i < model.vertexCount; i++) {
    const b = skin.bone[i] * 12;
    const w = skin.weight[i];
    const t = skin.target[i] * 3;
    const v = i * 3;
    if (b + 12 > bones.length) throw new Error(`vertex ${i} uses bone ${skin.bone[i]}; skeleton has ${bones.length / 12}`);
    for (let r = 0; r < 3; r++) {
      const m = b + r * 3;
      positions[t + r] += w * (bones[m] * p[v] + bones[m + 1] * p[v + 1] + bones[m + 2] * p[v + 2] + bones[b + 9 + r]);
      normals[t + r] += w * (bones[m] * n[v] + bones[m + 1] * n[v + 1] + bones[m + 2] * n[v + 2]);
    }
  }
  for (let i = 0; i < skin.renderCount * 3; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return { positions, normals };
}

/**
 * How well a skeleton fits a type 1 model, in model units. In the bind pose all of a vertex's influence records
 * should land on the same point, so this is the largest distance between a vertex's records (Infinity if the model
 * uses bones the skeleton lacks). The intended skeleton scores ~1 (up to ~60); wrong ones score hundreds.
 */
export function skinFitError(model: MefModel, skeleton: Skeleton): number {
  const skin = model.skin;
  if (!skin) return Infinity;
  const world = new Float32Array(skeleton.boneCount * 3);
  for (let i = 0; i < skeleton.boneCount; i++) {
    const p = skeleton.parents[i];
    for (let k = 0; k < 3; k++) world[i * 3 + k] = skeleton.translations[i * 3 + k] + (p < 0 ? 0 : world[p * 3 + k]);
  }
  const at = (i: number, k: number) => model.positions[i * 3 + k] + world[skin.bone[i] * 3 + k];
  let worst = 0;
  for (let i = 0; i < model.vertexCount; i++) {
    if (skin.bone[i] >= skeleton.boneCount) return Infinity;
    const t = skin.target[i];
    if (t !== i) worst = Math.max(worst, Math.hypot(at(i, 0) - at(t, 0), at(i, 1) - at(t, 1), at(i, 2) - at(t, 2)));
  }
  return worst;
}
