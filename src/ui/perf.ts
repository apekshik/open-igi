// The F3 performance overlay: frames per second, frame time (average and worst over the last second), draw calls,
// triangles, render resolution and JS heap. Off by default; the choice is remembered in this browser.
import type { Game } from "../game/game.ts";

const KEY = "open-igi:perf";

export class PerfOverlay {
  private el = document.createElement("div");
  private frames: number[] = [];
  private last = 0;
  private shownAt = 0;
  private on = false;

  constructor(host: HTMLElement) {
    this.el.style.cssText =
      "position:absolute;left:8px;top:8px;z-index:6;padding:4px 8px;background:rgba(0,0,0,0.6);color:#8cf07a;" +
      "font:12px/1.35 ui-monospace,Consolas,monospace;white-space:pre;pointer-events:none;display:none";
    host.append(this.el);
    let saved = false;
    try {
      saved = localStorage.getItem(KEY) === "1";
    } catch {
      // storage blocked: off
    }
    this.set(saved || new URLSearchParams(location.search).has("perf"));
  }

  get visible() {
    return this.on;
  }

  toggle() {
    this.set(!this.on);
    try {
      localStorage.setItem(KEY, this.on ? "1" : "0");
    } catch {
      // not remembered
    }
  }

  private set(on: boolean) {
    this.on = on;
    this.el.style.display = on ? "block" : "none";
    this.frames = [];
    this.last = 0;
  }

  /** Call once per rendered frame; `show` false hides it for now (the map computer covers the screen). */
  frame(game: Game, show = true) {
    if (!this.on) return;
    this.el.style.display = show ? "block" : "none";
    const now = performance.now();
    if (this.last) this.frames.push(now - this.last);
    this.last = now;
    if (now - this.shownAt < 500) return;
    this.shownAt = now;
    // Keep about one second of frame times.
    let sum = 0;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      sum += this.frames[i];
      if (sum > 1000) {
        this.frames.splice(0, i);
        break;
      }
    }
    const total = this.frames.reduce((a, b) => a + b, 0);
    const avg = this.frames.length ? total / this.frames.length : 0;
    const worst = this.frames.length ? Math.max(...this.frames) : 0;
    const info = game.renderer.info;
    const canvas = game.renderer.domElement;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const lines = [
      `${avg ? Math.round(1000 / avg) : 0} fps  ${avg.toFixed(1)} ms (worst ${worst.toFixed(1)})`,
      `${info.render.calls} draws  ${(info.render.triangles / 1000).toFixed(0)}k tris`,
      `${canvas.width}x${canvas.height}  ${info.memory.textures} tex  ${info.memory.geometries} geo`,
    ];
    if (memory) lines.push(`heap ${(memory.usedJSHeapSize / 1048576).toFixed(0)} MB`);
    this.el.textContent = lines.join("\n");
  }

  dispose() {
    this.el.remove();
  }
}
