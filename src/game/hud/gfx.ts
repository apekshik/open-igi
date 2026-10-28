// 2D assets for the HUD, map computer and menus: the game's sprites (.spr), full-screen pictures (.pic), bitmap fonts
// (.fnt) and string tables, decoded from the player's install into canvases. Shared by src/game/hud and src/ui.
import { cString, parseIlff, readRes } from "../../formats/ilff.ts";
import { decodeFont, type IgiFont } from "../../formats/font.ts";
import { decodeTexArray } from "../../formats/tex.ts";
import type { Vfs } from "../../vfs/vfs.ts";

/** A decoded .spr/.pic: one or more animation frames of the same size. */
export interface Sprite {
  width: number;
  height: number;
  frames: HTMLCanvasElement[];
}

/**
 * Decode a version 9 LOOP texture as a sprite. Its footer (at the header's +0x1C) says how the images go together:
 *   "LOOP" u32 6, u32 width, u32 height, u32 columns, u32 rows, then per image 16 bytes: u32 ?, u32 x, u32 y, u32 ?.
 * Pictures (.pic) are 64x32 tiles placed at (x, y) to make one image; animated sprites (clip20.spr: 61 frames) have
 * all images at (0, 0) and are separate frames. See docs/formats/ui.md.
 */
export function decodeSprite(bytes: Uint8Array): Sprite {
  const images = decodeTexArray(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footer = view.getUint32(28, true);
  const canvasOf = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h });
  const put = (c: HTMLCanvasElement, img: (typeof images)[number], x: number, y: number) =>
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer), img.width, img.height), x, y);
  const pos = (i: number) => [view.getUint32(footer + 24 + i * 16 + 4, true), view.getUint32(footer + 24 + i * 16 + 8, true)];
  const tiled = images.length > 1 && footer + 24 + images.length * 16 <= bytes.length && images.some((_, i) => pos(i)[0] || pos(i)[1]);
  if (tiled) {
    const width = view.getUint32(footer + 8, true);
    const height = view.getUint32(footer + 12, true);
    const c = canvasOf(width, height);
    images.forEach((img, i) => put(c, img, pos(i)[0], pos(i)[1]));
    return { width, height, frames: [c] };
  }
  const frames = images.map((img) => {
    const c = canvasOf(img.width, img.height);
    put(c, img, 0, 0);
    return c;
  });
  return { width: images[0].width, height: images[0].height, frames };
}

export interface TextOptions {
  color?: string;
  /** Horizontal alignment relative to x. */
  align?: "left" | "center" | "right";
  /** Pixel scale (fonts are drawn with nearest-neighbour sampling off for smoothness). */
  scale?: number;
  alpha?: number;
}

/** An IGI bitmap font that draws tinted text onto a 2D canvas. */
export class BitmapFont implements UiFont {
  readonly font: IgiFont;
  private atlas: HTMLCanvasElement;
  private tinted = new Map<string, HTMLCanvasElement>();

  constructor(font: IgiFont) {
    this.font = font;
    const { width, height, rgba } = font.atlas;
    this.atlas = Object.assign(document.createElement("canvas"), { width, height });
    this.atlas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), width, height), 0, 0);
  }

  get lineHeight() {
    return this.font.lineHeight;
  }

  /** Width of `text` in font pixels (unscaled). */
  measure(text: string): number {
    let w = 0;
    for (const ch of text) w += this.font.chars[ch.charCodeAt(0) & 255]?.advance ?? this.font.spaceWidth;
    return w;
  }

  /** Split text into lines no wider than `width` font pixels. */
  wrap(text: string, width: number): string[] {
    return wrapText(this, text, width);
  }

  /** Draw text with its line box's top-left at (x, y) (or top-centre / top-right per `align`). */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, options: TextOptions = {}) {
    const scale = options.scale ?? 1;
    const atlas = this.tint(options.color ?? "#ffffff");
    let pen = x;
    if (options.align === "center") pen -= (this.measure(text) * scale) / 2;
    else if (options.align === "right") pen -= this.measure(text) * scale;
    const alpha = ctx.globalAlpha;
    if (options.alpha !== undefined) ctx.globalAlpha = alpha * options.alpha;
    for (const ch of text) {
      const g = this.font.chars[ch.charCodeAt(0) & 255];
      if (!g) {
        pen += this.font.spaceWidth * scale;
        continue;
      }
      if (g.width > 0 && g.height > 0) ctx.drawImage(atlas, g.x, g.y, g.width, g.height, pen, y + g.top * scale, g.width * scale, g.height * scale);
      pen += g.advance * scale;
    }
    ctx.globalAlpha = alpha;
  }

  private tint(color: string): HTMLCanvasElement {
    let c = this.tinted.get(color);
    if (c) return c;
    c = Object.assign(document.createElement("canvas"), { width: this.atlas.width, height: this.atlas.height });
    const ctx = c.getContext("2d")!;
    ctx.drawImage(this.atlas, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    this.tinted.set(color, c);
    return c;
  }
}

/** Every NAME → CSTR pair in a string-table .res (menusystem/english.res, language/<lang>/*.res), keyed by the
 *  last path component of the name ("LOCAL:english/Mission 1 Name" → "Mission 1 Name"). */
export function readStrings(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  for (const c of parseIlff(bytes).chunks) {
    if (c.tag === "NAME") name = cString(c.data);
    else if (c.tag === "CSTR" && name) {
      out.set(name.slice(name.lastIndexOf("/") + 1), cString(c.data));
      name = null;
    }
  }
  return out;
}

/** Lazily decoded sprites, fonts and strings from the game's 2D archives. */
export class UiAssets {
  private vfs: Vfs;
  private archives = new Map<string, Promise<Map<string, Uint8Array>>>();
  private sprites = new Map<string, Sprite | null>();
  private fonts = new Map<string, UiFont>();

  constructor(vfs: Vfs) {
    this.vfs = vfs;
  }

  /** Short-name → payload map of an IRES archive ("status.res" entries are keyed "health.spr", ...). */
  archive(path: string): Promise<Map<string, Uint8Array>> {
    let p = this.archives.get(path);
    if (!p) {
      p = (async () => {
        const map = new Map<string, Uint8Array>();
        if (!this.vfs.has(path)) return map;
        for (const e of readRes(await this.vfs.read(path))) map.set(e.name.slice(e.name.lastIndexOf("/") + 1).toLowerCase(), e.data);
        return map;
      })();
      this.archives.set(path, p);
    }
    return p;
  }

  /** Load archives so sprite()/font() can find their entries. */
  async preload(...paths: string[]) {
    await Promise.all(paths.map((p) => this.archive(p)));
  }

  /** A sprite from an already loaded archive, or null if missing/undecodable. */
  async sprite(archive: string, name: string): Promise<Sprite | null> {
    const key = `${archive}|${name.toLowerCase()}`;
    if (this.sprites.has(key)) return this.sprites.get(key)!;
    const data = (await this.archive(archive)).get(name.toLowerCase());
    let s: Sprite | null = null;
    try {
      if (data) s = decodeSprite(data);
    } catch (err) {
      console.warn(`sprite ${name}:`, err);
    }
    this.sprites.set(key, s);
    return s;
  }

  /** A font from an archive; a system font of about `fallbackSize` pixels if it is missing or unreadable. */
  async font(archive: string, name: string, fallbackSize = 12): Promise<UiFont> {
    const key = `${archive}|${name.toLowerCase()}`;
    if (this.fonts.has(key)) return this.fonts.get(key)!;
    const data = (await this.archive(archive)).get(name.toLowerCase());
    let f: UiFont = new CanvasFont(fallbackSize);
    try {
      if (data) f = new BitmapFont(decodeFont(data));
    } catch (err) {
      console.warn(`font ${name}:`, err);
    }
    this.fonts.set(key, f);
    return f;
  }

  async strings(path: string): Promise<Map<string, string>> {
    if (!this.vfs.has(path)) return new Map();
    return readStrings(await this.vfs.read(path));
  }
}

/** Text drawing used by the HUD and menus: an IGI bitmap font, or a system font when the game's cannot be read. */
export interface UiFont {
  readonly lineHeight: number;
  measure(text: string): number;
  wrap(text: string, width: number): string[];
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, options?: TextOptions): void;
}

/** System-font stand-in with the same interface (keeps the UI usable without the game's fonts). */
export class CanvasFont implements UiFont {
  readonly lineHeight: number;
  private css: string;
  private probe = document.createElement("canvas").getContext("2d")!;

  constructor(size: number) {
    this.lineHeight = Math.round(size * 1.3);
    this.css = `bold ${size}px Tahoma, Verdana, sans-serif`;
    this.probe.font = this.css;
  }

  measure(text: string) {
    return this.probe.measureText(text).width;
  }

  wrap(text: string, width: number) {
    return wrapText(this, text, width);
  }

  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, options: TextOptions = {}) {
    const scale = options.scale ?? 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.font = this.css;
    ctx.textBaseline = "top";
    ctx.textAlign = options.align ?? "left";
    ctx.fillStyle = options.color ?? "#fff";
    if (options.alpha !== undefined) ctx.globalAlpha *= options.alpha;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

function wrapText(font: { measure(t: string): number }, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.measure(next) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}
