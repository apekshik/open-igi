// Terrain files: .ctr (cube octree), .cmd (per-cube meshes), .hmp (height patches). See docs/FORMATS.md.
// Layouts and the octree walk follow hjcminus/Project-IGI-Terrain (MIT); see THIRD_PARTY.md.

/** One octree cube: up to 8 children, each placed with one of 8 rotate/mirror transforms. */
export interface CtrNode {
  children: Int16Array;
  /** Transform per child slot (0..7), or -1 where the slot is empty. */
  transforms: Int8Array;
  childMask: number;
  /** Byte offset of this cube's mesh in the .cmd file. */
  cmdOffset: number;
}

const CTR_RECORD = 32;
const CTR_RECORD_44 = 44;
/** At +0x24 of every 44-byte record (flawme/igi-reverse-engineering, docs 16-verified-formats). */
const CTR_44_SIGNATURE = [0xef, 0xff, 0xff, 0xff, 0x5f, 0xfe, 0xff, 0x07];

/**
 * Level 14's .ctr has 44-byte records (same first 25 bytes) and no .cmd offsets: its .cmd is a linear run of
 * 4,779 meshes for 11,055 cubes, and how cubes pick their mesh is not known yet. Its size is also a multiple of 32,
 * so it is told apart by the constant bytes every 44-byte record carries.
 */
export function isCtr44(bytes: Uint8Array): boolean {
  if (bytes.length % CTR_RECORD_44 || bytes.length < 2 * CTR_RECORD_44) return false;
  return CTR_44_SIGNATURE.every((b, i) => bytes[CTR_RECORD_44 + 0x24 + i] === b);
}

export function parseCtr(bytes: Uint8Array): CtrNode[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isCtr44(bytes)) throw new Error(".ctr has 44-byte records (level14), whose cube meshes cannot be located yet");
  if (bytes.length % CTR_RECORD) throw new Error(`.ctr size ${bytes.length} is not a multiple of ${CTR_RECORD}`);
  const nodes: CtrNode[] = [];
  for (let at = 0; at < bytes.length; at += CTR_RECORD) {
    const children = new Int16Array(8);
    const transforms = new Int8Array(8);
    for (let k = 0; k < 8; k++) {
      children[k] = view.getInt16(at + k * 2, true);
      transforms[k] = view.getInt8(at + 16 + k);
    }
    nodes.push({ children, transforms, childMask: bytes[at + 24], cmdOffset: view.getUint32(at + 28, true) });
  }
  return nodes;
}

/**
 * A cube mesh in the .cmd file:
 *   u16 triangleCount, u16 vertexOffset (= triangleCount*4), u16 parentVertexCount, u16 childVertexCount,
 *   u32 triangles[triangleCount]  (bytes 0..2 are vertex indices, byte 3 a flag/material nibble)
 *   u32 vertices[parent + child]  (6-bit fields: x at bit 26, y at bit 20, z at bit 14, each biased by 24)
 */
export interface CmdMesh {
  triangles: Uint32Array;
  vertices: Uint32Array;
}

export function readCmd(cmd: Uint8Array, offset: number): CmdMesh {
  const view = new DataView(cmd.buffer, cmd.byteOffset + offset);
  const triangleCount = view.getUint16(0, true);
  const vertexCount = view.getUint16(4, true) + view.getUint16(6, true);
  const triangles = new Uint32Array(triangleCount);
  const vertices = new Uint32Array(vertexCount);
  for (let i = 0; i < triangleCount; i++) triangles[i] = view.getUint32(8 + i * 4, true);
  for (let i = 0; i < vertexCount; i++) vertices[i] = view.getUint32(8 + (triangleCount + i) * 4, true);
  return { triangles, vertices };
}

/**
 * .hmp: 256 slots of { u32 runtimePointer, u8 ?, u8[3] pad, u32 size }, then for each non-empty slot in order
 * a (size+1) x (size+1) grid of u8 heights. Absent in levels without height patches.
 */
export function parseHmp(bytes: Uint8Array): (Uint8Array | null)[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slots: (Uint8Array | null)[] = [];
  let body = 256 * 12;
  for (let i = 0; i < 256; i++) {
    const size = view.getUint32(i * 12 + 8, true);
    if (!size) {
      slots.push(null);
      continue;
    }
    const n = (size + 1) * (size + 1);
    slots.push(bytes.subarray(body, body + n));
    body += n;
  }
  if (body !== bytes.length) throw new Error(`.hmp walk ended at ${body} of ${bytes.length}`);
  return slots;
}

/** .bit: the same 256-slot table as .hmp, then for each non-empty slot a size x size bitmap, 1 bit per cell. */
export function parseBit(bytes: Uint8Array): ({ size: number; bits: Uint8Array } | null)[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slots: ({ size: number; bits: Uint8Array } | null)[] = [];
  let body = 256 * 12;
  for (let i = 0; i < 256; i++) {
    const size = view.getUint32(i * 12 + 8, true);
    if (!size) {
      slots.push(null);
      continue;
    }
    const n = (size * size) / 8;
    slots.push({ size, bits: bytes.subarray(body, body + n) });
    body += n;
  }
  if (body !== bytes.length) throw new Error(`.bit walk ended at ${body} of ${bytes.length}`);
  return slots;
}

/** .lmp: back-to-back 8-bit greyscale square lightmaps, each `u32 size` then size*size bytes. */
export function parseLmp(bytes: Uint8Array): { size: number; pixels: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maps: { size: number; pixels: Uint8Array }[] = [];
  for (let at = 0; at < bytes.length; ) {
    const size = view.getUint32(at, true);
    maps.push({ size, pixels: bytes.subarray(at + 4, at + 4 + size * size) });
    at += 4 + size * size;
  }
  return maps;
}

/** One material's settings at one octree level, from terrain.qvm CreateTerrainMaterial. */
export interface TerrainMaterialLevel {
  /** Near ("tex1") and far ("tex2") texture frequencies, already halved as the engine does. */
  freq1: number;
  freq2: number;
  /** Tile maps choosing the near and far texture. */
  tileMap1: number;
  tileMap2: number;
}

export interface TerrainMaterials {
  /** materials[material][level 0..31]. */
  materials: TerrainMaterialLevel[][];
  /** tileMaps[group]: 8x8 texture indices into terrain.tex, row-major by y. */
  tileMaps: number[][];
}

/**
 * terrain.qvm calls:
 *   CreateTerrainMaterial(material, id, 32 x {bool, v1, v2, freq2, tileMap2, freq1, tileMap1})
 *   CreateTerrainTileMap(group, 64 texture indices)
 */
export function terrainMaterials(statements: { fn: string; args: unknown[] }[]): TerrainMaterials {
  const materials: TerrainMaterialLevel[][] = [];
  const tileMaps: number[][] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  for (const s of statements) {
    if (s.fn === "CreateTerrainMaterial") {
      const levels: TerrainMaterialLevel[] = [];
      for (let l = 0; l < 32; l++) {
        const a = 2 + l * 7;
        levels.push({ freq2: num(s.args[a + 3]) * 0.5, tileMap2: num(s.args[a + 4]), freq1: num(s.args[a + 5]) * 0.5, tileMap1: num(s.args[a + 6]) });
      }
      materials[num(s.args[0])] = levels;
    } else if (s.fn === "CreateTerrainTileMap") {
      tileMaps[num(s.args[0])] = s.args.slice(1, 65).map(num);
    }
  }
  return { materials, tileMaps };
}
