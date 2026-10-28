// .tex: "LOOP" texture. Version 11 is what the mission archives use. See docs/FORMATS.md.
//
//   v11 header (32 bytes):
//     0  "LOOP"
//     4  u32 version (11)
//     8  u16 format      2 = 16-bit ARGB1555, no mips;  67 (0x40|3) = 32-bit ARGB8888 + full mip chain
//    20  u16 unknown (5 in every file seen)
//    22  u16 width, u16 height, u16 width, u16 height (repeated)
//    30  u16 bytes per pixel
//   then mip 0 pixels (w*h*bpp), then smaller mips if format has 0x40.

export interface Texture {
  width: number;
  height: number;
  format: number;
  /** Mip 0 as RGBA8, row-major from the top-left. */
  rgba: Uint8Array<ArrayBuffer>;
}

const HEADER = 32;

export function decodeTex(bytes: Uint8Array): Texture {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "LOOP") throw new Error(`not a texture (magic ${magic})`);
  const version = view.getUint32(4, true);
  if (version !== 11) throw new Error(`unsupported texture version ${version}`);
  const format = view.getUint16(8, true);
  const width = view.getUint16(22, true);
  const height = view.getUint16(24, true);
  const bpp = view.getUint16(30, true);
  const n = width * height;
  if (HEADER + n * bpp > bytes.length) throw new Error(`texture ${width}x${height}x${bpp} overruns ${bytes.length} bytes`);

  const rgba = new Uint8Array(n * 4);
  const kind = format & 0x3f;
  if (kind === 2 && bpp === 2) {
    for (let i = 0; i < n; i++) {
      const p = view.getUint16(HEADER + i * 2, true);
      rgba[i * 4] = expand5((p >> 10) & 31);
      rgba[i * 4 + 1] = expand5((p >> 5) & 31);
      rgba[i * 4 + 2] = expand5(p & 31);
      rgba[i * 4 + 3] = p & 0x8000 ? 255 : 0;
    }
  } else if (kind === 3 && bpp === 4) {
    // Little-endian ARGB8888 is B, G, R, A in memory.
    for (let i = 0; i < n; i++) {
      const s = HEADER + i * 4;
      rgba[i * 4] = bytes[s + 2];
      rgba[i * 4 + 1] = bytes[s + 1];
      rgba[i * 4 + 2] = bytes[s];
      rgba[i * 4 + 3] = bytes[s + 3];
    }
  } else {
    throw new Error(`unsupported texture format ${format} (bpp ${bpp})`);
  }
  return { width, height, format, rgba };
}

function expand5(v: number): number {
  return (v << 3) | (v >> 2);
}
