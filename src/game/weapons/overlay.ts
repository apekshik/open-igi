// Built-in zoom overlays (binoculars, sniper scope) drawn from the game's own sprites, plus the flashbang white-out.
// common/sprites/binoculars.spr is the left eyepiece (mirrored for the right one, stretched to full height) and
// snipersight.spr the top-left quarter of the scope ring (mirrored into four). Used when `drawOverlay` is on (the HUD normally draws the optics).
import type { ZoomKind } from "./api.ts";
import { spriteCanvas, type Sprite } from "./sprite.ts";

export class ZoomOverlay {
  private root: HTMLDivElement;
  private binoculars: HTMLDivElement;
  private scope: HTMLDivElement;
  private label: HTMLDivElement;
  private white: HTMLDivElement;
  private whiteness = 0;

  constructor(parent: HTMLElement, sprites: Map<string, Sprite>) {
    this.root = el("position:absolute;inset:0;pointer-events:none;display:none");
    this.binoculars = this.frame(sprites.get("binoculars"), "#000", false);
    this.scope = this.frame(sprites.get("snipersight"), "#000", true);
    // Thin crosshair over the scope.
    const cross = el("position:absolute;inset:0");
    cross.append(
      el("position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(0,0,0,.85)"),
      el("position:absolute;top:0;bottom:0;left:50%;width:1px;background:rgba(0,0,0,.85)"),
    );
    this.scope.append(cross);
    const bcross = el("position:absolute;left:50%;top:50%;width:24px;height:24px;margin:-12px 0 0 -12px");
    bcross.append(
      el("position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(160,255,160,.7)"),
      el("position:absolute;top:0;bottom:0;left:50%;width:1px;background:rgba(160,255,160,.7)"),
    );
    this.binoculars.append(bcross);
    this.label = el("position:absolute;right:12%;bottom:14%;color:#9f9;font:14px monospace;text-shadow:0 0 3px #000");
    this.binoculars.append(this.label);
    this.white = el("position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none");
    this.root.append(this.binoculars, this.scope);
    parent.append(this.root, this.white);
  }

  /**
   * A full-screen frame from one sprite mirrored left/right (and top/bottom when `quarters`), or a CSS vignette
   * when the sprite is missing.
   */
  private frame(sprite: Sprite | undefined, fill: string, quarters: boolean): HTMLDivElement {
    const box = el("position:absolute;inset:0;display:none");
    if (!sprite) {
      box.style.background = `radial-gradient(ellipse 42% 42% at 50% 50%, transparent 96%, ${fill} 100%)`;
      return box;
    }
    // Keep the frame square-ish in the middle and fill the sides with black.
    const frame = el(`position:absolute;top:0;bottom:0;left:50%;aspect-ratio:4/3;height:100%;transform:translateX(-50%);display:grid;grid-template:${quarters ? "1fr 1fr" : "1fr"}/1fr 1fr`);
    const cells = quarters ? ([[false, false], [true, false], [false, true], [true, true]] as const) : ([[false, false], [true, false]] as const);
    for (const [fx, fy] of cells) {
      const c = spriteCanvas(sprite, fx, fy);
      c.style.cssText = "width:100%;height:100%;display:block;image-rendering:auto";
      frame.append(c);
    }
    const left = el(`position:absolute;top:0;bottom:0;left:0;right:calc(50% + 66.7vh);background:${fill}`);
    const right = el(`position:absolute;top:0;bottom:0;right:0;left:calc(50% + 66.7vh);background:${fill}`);
    box.append(left, right, frame);
    return box;
  }

  show(kind: ZoomKind, fov: number, baseFov: number) {
    this.root.style.display = kind === "binoculars" || kind === "scope" ? "" : "none";
    this.binoculars.style.display = kind === "binoculars" ? "" : "none";
    this.scope.style.display = kind === "scope" ? "" : "none";
    if (kind === "binoculars") {
      const zoom = Math.tan((baseFov * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
      this.label.textContent = `x${zoom.toFixed(1)}`;
    }
  }

  hide() {
    this.root.style.display = "none";
  }

  /** Flashbang: jump to white (0..1) and fade out. */
  flash(strength: number) {
    this.whiteness = Math.max(this.whiteness, Math.min(1, strength) * 4);
  }

  update(dt: number) {
    if (this.whiteness <= 0) return;
    this.whiteness = Math.max(0, this.whiteness - dt);
    this.white.style.opacity = String(Math.min(1, this.whiteness));
  }
}

function el(css: string): HTMLDivElement {
  return Object.assign(document.createElement("div"), { style: css });
}
