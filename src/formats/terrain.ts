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

export function parseCtr(bytes: Uint8Array): CtrNode[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
