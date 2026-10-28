// .mef: model. An ILFF file (form "MECO", stored reversed as "OCEM") whose chunks hold render geometry, portals,
// attachments and a collision mesh. Chunk tags are little-endian u32s, so "MESH" reads from disk as "HSEM".
// This reader covers render geometry only. See docs/FORMATS.md.

import { parseIlff } from "./ilff.ts";

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
  return { type, vertexCount, positions, normals, uvs, batches };
}
