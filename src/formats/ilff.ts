// ILFF: IGI's chunked container (an IFF variant, little-endian, 4-byte aligned).
//
//   file   := "ILFF" u32 fileSize  u32 align  u32 reserved  tag4 formType  chunk*
//   chunk  := tag4 u32 length  u32 align  u32 next  u8[length]
//
// The first chunk starts at the 20-byte header rounded up to `align` (4 in most files, 32 in some archives).
// `next` is the offset from the start of this chunk header to the next chunk header; 0 ends the list.
// See docs/FORMATS.md.

export interface IlffChunk {
  tag: string;
  /** Absolute offset of the chunk payload within the source buffer. */
  offset: number;
  length: number;
  data: Uint8Array;
}

export interface IlffFile {
  formType: string;
  chunks: IlffChunk[];
}

const HEADER = 20;
const CHUNK_HEADER = 16;

export function readTag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

export function isIlff(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER && readTag(bytes, 0) === "ILFF";
}

export function parseIlff(bytes: Uint8Array): IlffFile {
  if (!isIlff(bytes)) throw new Error(`not an ILFF file (magic ${readTag(bytes, 0)})`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formType = readTag(bytes, 16);
  const chunks: IlffChunk[] = [];
  const align = Math.max(1, view.getUint32(8, true));
  let at = Math.ceil(HEADER / align) * align;
  while (at + CHUNK_HEADER <= bytes.length) {
    const tag = readTag(bytes, at);
    const length = view.getUint32(at + 4, true);
    const next = view.getUint32(at + 12, true);
    const offset = at + CHUNK_HEADER;
    if (offset + length > bytes.length) throw new Error(`chunk ${tag} at ${at} overruns file (${length} bytes)`);
    chunks.push({ tag, offset, length, data: bytes.subarray(offset, offset + length) });
    if (next === 0) break;
    at += next;
  }
  return { formType, chunks };
}

export interface ResEntry {
  /** Virtual path as stored, e.g. "LOCAL:common/sounds/wire_drag_1.wav". */
  name: string;
  data: Uint8Array;
}

/** Unpack an IRES archive into its NAME/BODY pairs. */
export function readRes(bytes: Uint8Array): ResEntry[] {
  const file = parseIlff(bytes);
  if (file.formType !== "IRES") throw new Error(`expected IRES form, got ${file.formType}`);
  const entries: ResEntry[] = [];
  let name: string | null = null;
  for (const c of file.chunks) {
    if (c.tag === "NAME") {
      name = cString(c.data);
    } else if (c.tag === "BODY") {
      entries.push({ name: name ?? `#${entries.length}`, data: c.data });
      name = null;
    }
  }
  return entries;
}

export function cString(data: Uint8Array): string {
  let end = data.indexOf(0);
  if (end < 0) end = data.length;
  let s = "";
  for (let i = 0; i < end; i++) s += String.fromCharCode(data[i]);
  return s;
}
