// Reader for common/sprites/*.spr (inside sprites.res) for the scope/binocular overlays and effect sprites. A sprite is
// a version 9 LOOP texture; multi-image ones are flip-book frames of the same size (blood1: 7 frames of 32x32), decoded
// with the shared texture reader (src/formats/tex.ts).
import * as THREE from "three";
import { readRes } from "../../formats/ilff.ts";
import { decodeTexArray } from "../../formats/tex.ts";
import type { Vfs } from "../../vfs/vfs.ts";

export interface Sprite {
  width: number;
  height: number;
  /** The first frame. */
  rgba: Uint8Array<ArrayBuffer>;
  /** Every frame (only when there is more than one). */
  frames?: Uint8Array<ArrayBuffer>[];
}

export function decodeSprite(bytes: Uint8Array): Sprite | null {
  if (bytes.length < 128 || String.fromCharCode(...bytes.subarray(0, 4)) !== "LOOP") return null;
  try {
    const images = decodeTexArray(bytes).filter((i) => i.width && i.height);
    if (!images.length) return null;
    const { width, height } = images[0];
    const frames = images.filter((i) => i.width === width && i.height === height).map((i) => i.rgba as Uint8Array<ArrayBuffer>);
    return { width, height, rgba: frames[0], frames: frames.length > 1 ? frames : undefined };
  } catch {
    return null;
  }
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
