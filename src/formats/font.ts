// .fnt: IGI's bitmap fonts, an ILFF container of form type FONT (menusystem/*.res, computer/computer.res,
// screens/intro/*.fnt). See docs/formats/ui.md.
//
//   FNTH (24 bytes)  i32 flag (1), i32 glyphCount, i32 (32, unread), i32 spaceWidth, i32 (24), i32 lineHeight
//   ANMF             glyphCount records of 40 bytes:
//                      +0x04 f32 u0, +0x08 f32 v0, +0x0C f32 u1, +0x10 f32 v1   (atlas UVs, 0..1)
//                      +0x16 i16 width, +0x18 i16 height, +0x1A i16 advance, +0x24 i16 top (offset in the line box)
//   TRAN (512 bytes) u16[256] Latin-1 character → glyph number (1-based; 0 = no glyph)
//   TEXH (24 bytes)  u16[7] atlas width, u16[8] atlas height, u16[11] bits per pixel (32)
//   BODY             atlas pixels, ARGB8888 little-endian (B, G, R, A in memory); glyphs are white, alpha is coverage
//
// Chunk roles and the TRAN/ANMF field offsets follow flawme/igi-reverse-engineering (reverse/docs/10-menus, MIT);
// see THIRD_PARTY.md.

import { parseIlff } from "./ilff.ts";

export interface FontGlyph {
  /** Pixel rectangle in the atlas. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pen advance after drawing, pixels. */
  advance: number;
  /** Distance from the top of the line box to the top of the glyph rectangle, pixels. */
  top: number;
}

export interface IgiFont {
  /** Glyph for each Latin-1 character code (null where the font has none, e.g. space). */
  chars: (FontGlyph | null)[];
  /** Advance for characters without a glyph (space). */
  spaceWidth: number;
  /** Height of the line box, pixels. */
  lineHeight: number;
  atlas: { width: number; height: number; rgba: Uint8Array<ArrayBuffer> };
}

const GLYPH = 40;

export function decodeFont(bytes: Uint8Array): IgiFont {
  const file = parseIlff(bytes);
  if (file.formType !== "FONT") throw new Error(`expected FONT form, got ${file.formType}`);
  const chunk = (tag: string) => {
    const c = file.chunks.find((c) => c.tag === tag);
    if (!c) throw new Error(`font has no ${tag} chunk`);
    return new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
  };
  const fnth = chunk("FNTH");
  const anmf = chunk("ANMF");
  const tran = chunk("TRAN");
  const texh = chunk("TEXH");
  const body = chunk("BODY");

  const width = texh.getUint16(14, true);
  const height = texh.getUint16(16, true);
  const bpp = texh.getUint16(22, true);
  if (bpp !== 32 || body.byteLength < width * height * 4) throw new Error(`unsupported font atlas ${width}x${height}x${bpp}`);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = body.getUint8(i * 4 + 2);
    rgba[i * 4 + 1] = body.getUint8(i * 4 + 1);
    rgba[i * 4 + 2] = body.getUint8(i * 4);
    rgba[i * 4 + 3] = body.getUint8(i * 4 + 3);
  }

  const count = Math.min(fnth.getInt32(4, true), anmf.byteLength / GLYPH);
  const glyphs: FontGlyph[] = [];
  for (let g = 0; g < count; g++) {
    const o = g * GLYPH;
    glyphs.push({
      x: Math.round(anmf.getFloat32(o + 4, true) * width),
      y: Math.round(anmf.getFloat32(o + 8, true) * height),
      width: anmf.getInt16(o + 0x16, true),
      height: anmf.getInt16(o + 0x18, true),
      advance: anmf.getInt16(o + 0x1a, true),
      top: anmf.getInt16(o + 0x24, true),
    });
  }
  const chars: (FontGlyph | null)[] = [];
  for (let c = 0; c < 256; c++) {
    const n = tran.getUint16(c * 2, true);
    chars.push(n > 0 && n <= glyphs.length ? glyphs[n - 1] : null);
  }
  return { chars, spaceWidth: fnth.getInt32(12, true), lineHeight: fnth.getInt32(20, true), atlas: { width, height, rgba } };
}
