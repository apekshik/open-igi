// Minimal reader for common/sprites/*.spr (inside sprites.res), enough for the scope/binocular overlays and effect
// sprites: "LOOP" version 9, u32 @40 width, u32 @44 height, u32 @48 format (3 = BGRA8888, 2 = ARGB1555); the first
// frame's pixels start at byte 124, rows from the top. Multi-frame sprites (blood1) are not split. Our own reading.
import * as THREE from "three";
import { readRes } from "../../formats/ilff.ts";
import type { Vfs } from "../../vfs/vfs.ts";

export interface Sprite {
  width: number;
  height: number;
  rgba: Uint8Array<ArrayBuffer>;
}

export function decodeSprite(bytes: Uint8Array): Sprite | null {
  if (bytes.length < 128 || String.fromCharCode(...bytes.subarray(0, 4)) !== "LOOP") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint32(40, true), height = v.getUint32(44, true), format = v.getUint32(48, true);
  const bpp = format === 3 ? 4 : format === 2 ? 2 : 0;
  if (!bpp || 124 + width * height * bpp > bytes.length) return null;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (bpp === 4) {
      const o = 124 + i * 4;
      rgba[i * 4] = bytes[o + 2];
      rgba[i * 4 + 1] = bytes[o + 1];
      rgba[i * 4 + 2] = bytes[o];
      rgba[i * 4 + 3] = bytes[o + 3];
    } else {
      const p = v.getUint16(124 + i * 2, true);
      rgba[i * 4] = ((p >> 10) & 31) * 8.226;
      rgba[i * 4 + 1] = ((p >> 5) & 31) * 8.226;
      rgba[i * 4 + 2] = (p & 31) * 8.226;
      rgba[i * 4 + 3] = p & 0x8000 ? 255 : 0;
    }
  }
  return { width, height, rgba };
}

/** All sprites in common/sprites/sprites.res by base name ("binoculars", "smoke1", ...). */
export async function loadSprites(vfs: Vfs): Promise<Map<string, Sprite>> {
  const out = new Map<string, Sprite>();
  const path = "common/sprites/sprites.res";
  if (!vfs.has(path)) return out;
  try {
    for (const e of readRes(await vfs.read(path))) {
      const s = decodeSprite(e.data);
      if (s) out.set(e.name.split("/").pop()!.replace(/\.spr$/i, "").toLowerCase(), s);
    }
  } catch (e) {
    console.warn("weapons: cannot read sprites", e);
  }
  return out;
}

export function spriteTexture(s: Sprite): THREE.Texture {
  const t = new THREE.DataTexture(s.rgba, s.width, s.height);
  t.flipY = false;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Sprite as a canvas (for DOM overlays), optionally mirrored. */
export function spriteCanvas(s: Sprite, flipX = false, flipY = false): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = s.width;
  c.height = s.height;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(s.width, s.height);
  img.data.set(s.rgba);
  if (!flipX && !flipY) {
    ctx.putImageData(img, 0, 0);
    return c;
  }
  const tmp = document.createElement("canvas");
  tmp.width = s.width;
  tmp.height = s.height;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  ctx.translate(flipX ? s.width : 0, flipY ? s.height : 0);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.drawImage(tmp, 0, 0);
  return c;
}
