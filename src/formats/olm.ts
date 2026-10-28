// Static-object lighting data: per-object lightmaps (.olm, in a level's lightmaps/lightmaps.res) and the parts of a
// .mef model that refer to them (LTMP, the second UV set of type 3 vertices) or place sub-models (ATTA).
// See docs/formats/world.md.
//
// .olm: a 104-byte header then BGRA8888 pixels, top row first.
//   0  f32 ?, f32 ?          (0.12 and 0.1 in every file seen)
//   8  u16[7] build time     year, month, day, hour, minute, second, millisecond (as u32s)
//  36  u32 0, u32 1, u32 1, u32 ? (texel count?), u32 ?, u32 ?, u32 0
//  64  u16 allocWidth, u16 allocHeight     power-of-two page the lightmapper allocated
//  68  u16 ?, u16 3
//  76  f32 width / allocWidth, f32 height / allocHeight
//  92  u32 ?, u32 ?
// 100  u16 width, u16 height               the stored image; the model's LTMP holds the same size
//
// One .olm per lightmapped model, named obj<NNNNN>_<MMMMM>.olm: obj<NNNNN> is the "Filename" of a LightmapInfo task
// (a child of the Building or other task that owns the lit objects) and MMMMM counts the models of that task's
// subtree in the order the lightmapper visited them (see lightmapOrder in src/render/statics.ts).

import { parseIlff } from "./ilff.ts";
import { tagName } from "./mef.ts";

export interface ObjectLightMap {
  width: number;
  height: number;
  /** RGBA8, top row first. Colour already includes the ambient term; the game multiplies it with the texture. */
  rgba: Uint8Array<ArrayBuffer>;
}

const OLM_HEADER = 104;

export function decodeOlm(bytes: Uint8Array): ObjectLightMap {
  if (bytes.length < OLM_HEADER) throw new Error(`.olm too short (${bytes.length} bytes)`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(100, true);
  const height = view.getUint16(102, true);
  // A few large objects (11 files) store further pages after the first (u32 @44 = page count); only page 0 is read.
  if (OLM_HEADER + width * height * 4 > bytes.length) throw new Error(`.olm ${width}x${height} overruns ${bytes.length} bytes`);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = OLM_HEADER + i * 4;
    rgba[i * 4] = bytes[s + 2];
    rgba[i * 4 + 1] = bytes[s + 1];
    rgba[i * 4 + 2] = bytes[s];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** A sub-model a model carries with it (ATTA chunk): room interiors, lamps, windows, railings. */
export interface MefAttachment {
  model: string;
  /** Offset in the parent's model space (IGI units, Z up). */
  position: [number, number, number];
  /** Row-major 3x3 rotation into the parent's model space. */
  rotation: number[];
}

export interface MefLighting {
  /** LTMP: the lightmap size the second UV set is laid out for, or null if the model is not lightmapped. */
  lightMapSize: [number, number] | null;
  /** Type 3 models: per-vertex lightmap UVs (0..1 over lightMapSize). */
  lightMapUvs: Float32Array | null;
  attachments: MefAttachment[];
  /** The model has an LTMP chunk, even an empty one: it takes a number in its owner's lightmap sequence. */
  lightMapSlot: boolean;
  /** The model has portals (PORT): a room, which the lightmapper visits after plain attachments. */
  portals: boolean;
}

// ATTA: 68-byte records: char[16] model name, vec3 position, f32[9] rotation (rows), u32 0.
const ATTA_RECORD = 68;

export function readMefLighting(bytes: Uint8Array): MefLighting {
  const file = parseIlff(bytes);
  const chunk = (name: string) => file.chunks.find((c) => tagName(c.tag) === name);
  const view = (c: { data: Uint8Array; length: number }) => new DataView(c.data.buffer, c.data.byteOffset, c.length);

  const attachments: MefAttachment[] = [];
  const atta = chunk("ATTA");
  if (atta) {
    const v = view(atta);
    for (let at = 0; at + ATTA_RECORD <= atta.length; at += ATTA_RECORD) {
      let model = "";
      for (let i = 0; i < 16 && atta.data[at + i]; i++) model += String.fromCharCode(atta.data[at + i]);
      const f = (k: number) => v.getFloat32(at + 16 + k * 4, true);
      attachments.push({ model, position: [f(0), f(1), f(2)], rotation: Array.from({ length: 9 }, (_, k) => f(3 + k)) });
    }
  }

  let lightMapSize: [number, number] | null = null;
  let lightMapUvs: Float32Array | null = null;
  const ltmp = chunk("LTMP");
  const mesh = chunk("MESH");
  const vrtx = chunk("VRTX");
  if (ltmp && ltmp.length >= 8 && mesh && vrtx) {
    const type = view(mesh).getUint32(32, true);
    const count = view(mesh).getUint32(100, true);
    const w = view(ltmp).getUint16(0, true);
    const h = view(ltmp).getUint16(2, true);
    if (type === 3 && count && vrtx.length === count * 40 && w && h) {
      lightMapSize = [w, h];
      lightMapUvs = new Float32Array(count * 2);
      const v = view(vrtx);
      for (let i = 0; i < count; i++) {
        lightMapUvs[i * 2] = v.getFloat32(i * 40 + 32, true);
        lightMapUvs[i * 2 + 1] = v.getFloat32(i * 40 + 36, true);
      }
    }
  }
  const port = chunk("PORT");
  return { lightMapSize, lightMapUvs, lightMapSlot: !!ltmp, attachments, portals: !!port && port.length > 0 };
}
