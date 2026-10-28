// .tex: "LOOP" texture. Version 11 is what the mission archives use; version 9 holds several images
// (terrain.tex). See docs/FORMATS.md.
//
//   v11 header (32 bytes):
//     0  "LOOP"
//     4  u32 version (11)
//     8  u16 format      2 = 16-bit ARGB1555, no mips;  67 (0x40|3) = 32-bit ARGB8888 + full mip chain
//    20  u16 unknown (5 in every file seen)
//    22  u16 width, u16 height, u16 width, u16 height (repeated)
//    30  u16 bytes per pixel
//   then mip 0 pixels (w*h*bpp), then smaller mips if format has 0x40.
//
//   v9 header (52 bytes): "LOOP", u32 version (9), u32[5] ?, u32 footerOffset, u32 imageCount, u32 ?,
//     u32 width, u32 height, u32 format; then imageCount 32-byte descriptors:
//     u32 pixelOffset, u32 format, u16 lineBytes, u16 width, u16 height, u16 ?, u32[4] reserved.

export interface Texture {
  width: number;
  height: number;
  format: number;
  /** Mip 0 as RGBA8, row-major from the top-left. */
  rgba: Uint8Array<ArrayBuffer>;
}

const HEADER = 32;
const V9_HEADER = 52;
const V9_IMAGE = 32;

export function decodeTex(bytes: Uint8Array): Texture {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  checkMagic(bytes);
  const version = view.getUint32(4, true);
  if (version !== 11) throw new Error(`unsupported texture version ${version}`);
  const format = view.getUint16(8, true);
  const width = view.getUint16(22, true);
  const height = view.getUint16(24, true);
  const bpp = view.getUint16(30, true);
  if (HEADER + width * height * bpp > bytes.length) throw new Error(`texture ${width}x${height}x${bpp} overruns ${bytes.length} bytes`);
  return { width, height, format, rgba: decodePixels(view, HEADER, width, height, width * bpp, format) };
}

/** A version 9 multi-image texture, e.g. the 18 ground textures in terrain.tex. */
export function decodeTexArray(bytes: Uint8Array): Texture[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  checkMagic(bytes);
  const version = view.getUint32(4, true);
  if (version !== 9) throw new Error(`expected a version 9 texture, got ${version}`);
  const count = view.getUint32(32, true);
  const images: Texture[] = [];
  for (let i = 0; i < count; i++) {
    const at = V9_HEADER + i * V9_IMAGE;
    const offset = view.getUint32(at, true);
    const format = view.getUint32(at + 4, true);
    const lineBytes = view.getUint16(at + 8, true);
    const width = view.getUint16(at + 10, true);
    const height = view.getUint16(at + 12, true);
    images.push({ width, height, format, rgba: decodePixels(view, offset, width, height, lineBytes, format) });
  }
  return images;
}

function checkMagic(bytes: Uint8Array) {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "LOOP") throw new Error(`not a texture (magic ${magic})`);
}

function decodePixels(view: DataView, offset: number, width: number, height: number, lineBytes: number, format: number) {
  const rgba = new Uint8Array(width * height * 4);
  const kind = format & 0x3f;
  const bpp = lineBytes / width;
  for (let y = 0; y < height; y++) {
    const row = offset + y * lineBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (kind === 2 && bpp === 2) {
        const p = view.getUint16(row + x * 2, true);
        rgba[o] = expand5((p >> 10) & 31);
        rgba[o + 1] = expand5((p >> 5) & 31);
        rgba[o + 2] = expand5(p & 31);
        rgba[o + 3] = p & 0x8000 ? 255 : 0;
      } else if (kind === 3 && bpp === 4) {
        // Little-endian ARGB8888 is B, G, R, A in memory.
        const s = row + x * 4;
        rgba[o] = view.getUint8(s + 2);
        rgba[o + 1] = view.getUint8(s + 1);
        rgba[o + 2] = view.getUint8(s);
        rgba[o + 3] = view.getUint8(s + 3);
      } else {
        throw new Error(`unsupported texture format ${format} (${bpp} bytes per pixel)`);
      }
    }
  }
  return rgba;
}

function expand5(v: number): number {
  return (v << 3) | (v >> 2);
}
