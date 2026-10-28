// A small widget toolkit for IGI's menus. Pages are laid out in the original's 640x480 menu coordinates (the numbers
// in menusystem/mainmenu.qvm and ingamemenu.qvm) and drawn on a canvas scaled to fit the screen, with the game's
// fonts, window-frame sprites, slider sprites, highlight glow and mouse pointer.
import type { Sprite, UiFont } from "../game/hud/gfx.ts";
import type { MenuAudio } from "./sound.ts";

export const MENU_W = 640;
export const MENU_H = 480;

/** Colour per MenuText "ColourIndex": 1 titles, 2 items, 3 small links. */
export const COLORS = {
  title: "#e2efcf",
  item: "#9cc387",
  hover: "#ffffff",
  small: "#86a874",
  disabled: "#55644c",
  value: "#c8e4b4",
  panel: "rgba(6,14,8,0.72)",
  line: "rgba(150,200,130,0.45)",
};

export interface MenuTheme {
  font1: UiFont;
  font3: UiFont;
  font4: UiFont;
  sprites: Map<string, Sprite | null>;
  audio: MenuAudio;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export abstract class Widget {
  rect: Rect;
  /** Takes focus / reacts to the mouse. */
  selectable = false;
  enabled = true;
  constructor(rect: Rect) {
    this.rect = rect;
  }
  abstract draw(ctx: CanvasRenderingContext2D, theme: MenuTheme, focused: boolean): void;
  click(_x: number, _y: number, _menu: MenuCanvas) {}
  drag(_x: number, _y: number) {}
  wheel(_dy: number) {}
  /** Left/right on a focused widget (sliders, toggles, lists); returns true if handled. */
  step(_dir: -1 | 1): boolean {
    return false;
  }
  /** Keys while focused (e.g. key capture); returns true if handled. */
  key(_e: KeyboardEvent): boolean {
    return false;
  }
}

export interface Page {
  /** Full-screen background picture, or null to show what is underneath (in-game menus dim the game). */
  background: Sprite | null;
  /** Darken the background (in-game menus). */
  dim?: boolean;
  /** Dark panel behind the widgets (the MenuScreen frame rectangle). */
  panel?: Rect;
  widgets: Widget[];
  onEscape?: () => void;
  /** Extra drawing after the widgets (logos, animations). */
  decorate?: (ctx: CanvasRenderingContext2D, theme: MenuTheme, time: number) => void;
}

/** The menu surface: one canvas over the game host, showing a page and optionally a popup dialog. */
export class MenuCanvas {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  readonly theme: MenuTheme;
  private page: Page | null = null;
  private popup: Page | null = null;
  private focus: Widget | null = null;
  private dragging: Widget | null = null;
  private mouse = { x: -100, y: -100 };
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private running = false;
  private time = 0;
  private cleanup: (() => void)[] = [];

  constructor(host: HTMLElement, theme: MenuTheme) {
    this.theme = theme;
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:none;cursor:none;z-index:10;outline:none";
    this.canvas.tabIndex = 0;
    host.append(this.canvas);
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, target: EventTarget = this.canvas) => {
      target.addEventListener(type, fn as EventListener, { passive: false });
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on("pointermove", (e) => {
      this.mouse = this.toMenu(e.offsetX, e.offsetY);
      if (this.dragging) this.dragging.drag(this.mouse.x, this.mouse.y);
      else this.hover();
    });
    on("pointerleave", () => (this.mouse = { x: -100, y: -100 }));
    on("pointerdown", (e) => {
      this.theme.audio.unlock();
      this.mouse = this.toMenu(e.offsetX, e.offsetY);
      const w = this.widgetAt(this.mouse.x, this.mouse.y);
      if (!w || !w.enabled) return;
      this.focus = w;
      this.dragging = w;
      this.canvas.setPointerCapture(e.pointerId);
      w.click(this.mouse.x, this.mouse.y, this);
    });
    on("pointerup", () => (this.dragging = null));
    on("wheel", (e) => {
      e.preventDefault();
      const m = this.toMenu(e.offsetX, e.offsetY);
      const w = this.active().widgets.find((w) => inside(w.rect, m.x, m.y));
      w?.wheel(Math.sign(e.deltaY));
    });
    on("keydown", (e) => this.keydown(e), window);
  }

  get visible() {
    return this.page !== null;
  }

  /** Show a page (replacing any popup). */
  show(page: Page) {
    this.page = page;
    this.popup = null;
    this.focus = null;
    this.canvas.style.display = "block";
    this.canvas.focus({ preventScroll: true });
    this.hover();
    if (!this.running) {
      this.running = true;
      let last = performance.now();
      const loop = (now: number) => {
        if (!this.running) return;
        this.time += (now - last) / 1000;
        last = now;
        this.draw();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  /** Show a dialog over the current page (IGI's "Are you sure?" popups). */
  showPopup(page: Page) {
    this.popup = page;
    this.focus = null;
  }

  /** Give a widget keyboard focus (Enter activates it). */
  setFocus(widget: Widget | null) {
    this.focus = widget;
  }

  closePopup() {
    this.popup = null;
    this.focus = null;
  }

  hide() {
    this.page = null;
    this.popup = null;
    this.running = false;
    this.canvas.style.display = "none";
  }

  /** Redraw now (also runs every animation frame while visible). */
  draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.scale = Math.min(w / MENU_W, h / MENU_H);
    this.ox = (w - MENU_W * this.scale) / 2;
    this.oy = (h - MENU_H * this.scale) / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    const page = this.page;
    if (!page) return;
    if (page.background) {
      // Cover the whole screen with the picture; the menu itself stays 4:3 in the middle.
      const bg = page.background;
      const k = Math.max(w / bg.width, h / bg.height);
      ctx.drawImage(bg.frames[0], (w - bg.width * k) / 2, (h - bg.height * k) / 2, bg.width * k, bg.height * k);
    }
    if (page.dim) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.ox, dpr * this.oy);
    this.drawPage(page, this.popup === null);
    if (this.popup) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(-this.ox / this.scale, -this.oy / this.scale, w / this.scale, h / this.scale);
      this.drawPage(this.popup, true);
    }
    const pointer = this.theme.sprites.get("pointer");
    if (pointer && this.mouse.x > -50) ctx.drawImage(pointer.frames[0], this.mouse.x, this.mouse.y);
  }

  private drawPage(page: Page, interactive: boolean) {
    const ctx = this.ctx;
    if (page.panel) drawWindow(ctx, this.theme, page.panel);
    for (const w of page.widgets) w.draw(ctx, this.theme, interactive && w === this.focus);
    page.decorate?.(ctx, this.theme, this.time);
  }

  private active(): Page {
    return this.popup ?? this.page ?? { background: null, widgets: [] };
  }

  private toMenu(px: number, py: number) {
    return { x: (px - this.ox) / this.scale, y: (py - this.oy) / this.scale };
  }

  private widgetAt(x: number, y: number) {
    return this.active().widgets.find((w) => w.selectable && inside(w.rect, x, y)) ?? null;
  }

  private hover() {
    const w = this.widgetAt(this.mouse.x, this.mouse.y);
    if (w && w !== this.focus && w.enabled) {
      this.focus = w;
      this.theme.audio.play("menu_high");
    }
  }

  private keydown(e: KeyboardEvent) {
    if (!this.page || this.canvas.style.display === "none") return;
    if (this.focus?.key(e)) {
      e.preventDefault();
      return;
    }
    const items = this.active().widgets.filter((w) => w.selectable && w.enabled);
    const at = this.focus ? items.indexOf(this.focus) : -1;
    if (e.code === "ArrowDown" || e.code === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const next = e.code === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      this.focus = items[next];
      this.theme.audio.play("menu_high");
    } else if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && this.focus) {
      e.preventDefault();
      this.focus.step(e.code === "ArrowLeft" ? -1 : 1);
    } else if ((e.code === "Enter" || e.code === "Space" || e.code === "NumpadEnter") && this.focus) {
      e.preventDefault();
      this.theme.audio.unlock();
      const r = this.focus.rect;
      this.focus.click(r.x + r.w / 2, r.y + r.h / 2, this);
    } else if (e.code === "Escape") {
      e.preventDefault();
      const page = this.active();
      if (page.onEscape) {
        this.theme.audio.play("menu_cancel");
        page.onEscape();
      }
    }
  }

  dispose() {
    this.hide();
    for (const c of this.cleanup) c();
    this.canvas.remove();
  }
}

/** A dark panel framed with the win2_* corner/edge sprites (corners 1/3/5/7, edges 2/4/6/8 clockwise from top-left). */
export function drawWindow(ctx: CanvasRenderingContext2D, theme: MenuTheme, r: Rect, fill = COLORS.panel) {
  ctx.fillStyle = fill;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const s = (i: number) => theme.sprites.get(`win2_${i}`) ?? null;
  const c = s(1)?.width ?? 0;
  if (!c) {
    ctx.strokeStyle = COLORS.line;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    return;
  }
  const img = (i: number) => s(i)!.frames[0];
  ctx.drawImage(img(1), r.x, r.y);
  ctx.drawImage(img(3), r.x + r.w - c, r.y);
  ctx.drawImage(img(5), r.x + r.w - c, r.y + r.h - c);
  ctx.drawImage(img(7), r.x, r.y + r.h - c);
  ctx.drawImage(img(2), r.x + c, r.y, r.w - 2 * c, s(2)!.height);
  ctx.drawImage(img(6), r.x + c, r.y + r.h - s(6)!.height, r.w - 2 * c, s(6)!.height);
  ctx.drawImage(img(8), r.x, r.y + c, s(8)!.width, r.h - 2 * c);
  ctx.drawImage(img(4), r.x + r.w - s(4)!.width, r.y + c, s(4)!.width, r.h - 2 * c);
}

/** The thin win1_* frame used around list boxes and pictures. */
export function drawThinFrame(ctx: CanvasRenderingContext2D, theme: MenuTheme, r: Rect) {
  const s = (i: number) => theme.sprites.get(`win1_${i}`) ?? null;
  if (!s(1)) {
    ctx.strokeStyle = COLORS.line;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    return;
  }
  const c = s(1)!.width;
  const img = (i: number) => s(i)!.frames[0];
  ctx.drawImage(img(1), r.x, r.y);
  ctx.drawImage(img(3), r.x + r.w - c, r.y);
  ctx.drawImage(img(5), r.x + r.w - c, r.y + r.h - c);
  ctx.drawImage(img(7), r.x, r.y + r.h - c);
  ctx.drawImage(img(2), r.x + c, r.y, r.w - 2 * c, s(2)!.height);
  ctx.drawImage(img(6), r.x + c, r.y + r.h - s(6)!.height, r.w - 2 * c, s(6)!.height);
  ctx.drawImage(img(8), r.x, r.y + c, s(8)!.width, r.h - 2 * c);
  ctx.drawImage(img(4), r.x + r.w - s(4)!.width, r.y + c, s(4)!.width, r.h - 2 * c);
}

function glow(ctx: CanvasRenderingContext2D, theme: MenuTheme, r: Rect) {
  const g = theme.sprites.get("glow");
  if (!g) return;
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.drawImage(g.frames[0], r.x - 10, r.y - 3, r.w + 20, r.h + 6);
  ctx.restore();
}

export class Label extends Widget {
  text: string;
  font: keyof Pick<MenuTheme, "font1" | "font3" | "font4">;
  color: string;
  align: "left" | "center" | "right";
  constructor(
    rect: Rect,
    text: string,
    font: keyof Pick<MenuTheme, "font1" | "font3" | "font4">,
    color = COLORS.title,
    align: "left" | "center" | "right" = "left",
  ) {
    super(rect);
    this.text = text;
    this.font = font;
    this.color = color;
    this.align = align;
  }
  draw(ctx: CanvasRenderingContext2D, theme: MenuTheme) {
    const f = theme[this.font];
    const x = this.align === "center" ? this.rect.x + this.rect.w / 2 : this.align === "right" ? this.rect.x + this.rect.w : this.rect.x;
    f.draw(ctx, this.text, x, this.rect.y + (this.rect.h - f.lineHeight) / 2, { color: this.color, align: this.align });
  }
}

/** Wrapped, optionally scrolling text (mission descriptions, briefings, read-me). */
export class TextBlock extends Widget {
  private offset = 0;
  text: string;
  font: keyof Pick<MenuTheme, "font1" | "font3" | "font4">;
  color: string;
  constructor(
    rect: Rect,
    text: string,
    font: keyof Pick<MenuTheme, "font1" | "font3" | "font4">,
    color = COLORS.value,
  ) {
    super(rect);
    this.text = text;
    this.font = font;
    this.color = color;
  }
  draw(ctx: CanvasRenderingContext2D, theme: MenuTheme) {
    const f = theme[this.font];
    const lines = f.wrap(this.text, this.rect.w);
    const fit = Math.max(1, Math.floor(this.rect.h / f.lineHeight));
    this.offset = Math.max(0, Math.min(this.offset, lines.length - fit));
    lines.slice(this.offset, this.offset + fit).forEach((l, i) => f.draw(ctx, l, this.rect.x, this.rect.y + i * f.lineHeight, { color: this.color }));
  }
  wheel(dy: number) {
    this.offset += dy * 2;
  }
}

/** A clickable menu text (MenuText): highlights with the glow sprite under the pointer. */
export class Button extends Widget {
  text: string;
  font: keyof Pick<MenuTheme, "font1" | "font3" | "font4">;
  sound: "menu_ok" | "menu_cancel" | "menu_sel";
  align: "left" | "center" | "right";
  onClick: () => void;
  constructor(
    rect: Rect,
    text: string,
    onClick: () => void,
    font: keyof Pick<MenuTheme, "font1" | "font3" | "font4"> = "font3",
    sound: "menu_ok" | "menu_cancel" | "menu_sel" = "menu_sel",
    align: "left" | "center" | "right" = "left",
  ) {
    super(rect);
    this.onClick = onClick;
    this.text = text;
    this.font = font;
    this.sound = sound;
    this.align = align;
    this.selectable = true;
  }
  draw(ctx: CanvasRenderingContext2D, theme: MenuTheme, focused: boolean) {
    const f = theme[this.font];
    const tw = f.measure(this.text);
    const x = this.align === "center" ? this.rect.x + this.rect.w / 2 : this.align === "right" ? this.rect.x + this.rect.w : this.rect.x;
    const left = this.align === "center" ? x - tw / 2 : this.align === "right" ? x - tw : x;
    if (focused && this.enabled) glow(ctx, theme, { x: left, y: this.rect.y, w: tw, h: this.rect.h });
    const color = !this.enabled ? COLORS.disabled : focused ? COLORS.hover : this.font === "font4" ? COLORS.small : COLORS.item;
    f.draw(ctx, this.text, x, this.rect.y + (this.rect.h - f.lineHeight) / 2, { color, align: this.align });
  }
  click(_x: number, _y: number, menu: MenuCanvas) {
    if (!this.enabled) return;
    menu.theme.audio.play(this.sound);
    this.onClick();
  }
}

/** A labelled row with a control on the right (MenuFrame LineUpMode 8: text + SlideBar/ToggleBox/ListBox). */
export abstract class OptionRow extends Widget {
  label: string;
  controlX: number;
  constructor(
    rect: Rect,
    label: string,
    /** X where the control starts. */
    controlX: number,
  ) {
    super(rect);
    this.label = label;
    this.controlX = controlX;
    this.selectable = true;
  }
  draw(ctx: CanvasRenderingContext2D, theme: MenuTheme, focused: boolean) {
    if (focused) glow(ctx, theme, { x: this.rect.x, y: this.rect.y, w: theme.font3.measure(this.label), h: this.rect.h });
    theme.font3.draw(ctx, this.label, this.rect.x, this.rect.y + (this.rect.h - theme.font3.lineHeight) / 2, { color: focused ? COLORS.hover : COLORS.item });
    this.drawControl(ctx, theme);
  }
  abstract drawControl(ctx: CanvasRenderingContext2D, theme: MenuTheme): void;
}

/** SlideBar: arrows at both ends (slide_1 / slide_2) and a knob (slide_3) on a track. */
export class Slider extends OptionRow {
  width: number;
  value: number;
  steps: number;
  onChange: (v: number) => void;
  constructor(
    rect: Rect,
    label: string,
    controlX: number,
    width: number,
    value: number,
    onChange: (v: number) => void,
    /** Discrete positions (e.g. detail levels); 0 = continuous. */
    steps = 0,
  ) {
    super(rect, label, controlX);
    this.onChange = onChange;
    this.width = width;
    this.value = value;
    this.steps = steps;
  }
  private track() {
    return { x: this.controlX + 14, w: this.width - 28, y: this.rect.y + this.rect.h / 2 };
  }
  drawControl(ctx: CanvasRenderingContext2D, theme: MenuTheme) {
    const left = theme.sprites.get("slide_1");
    const right = theme.sprites.get("slide_2");
    const knob = theme.sprites.get("slide_3");
    const t = this.track();
    const top = t.y - 6;
    if (left) ctx.drawImage(left.frames[0], this.controlX, top);
    if (right) ctx.drawImage(right.frames[0], this.controlX + this.width - (right.width || 11), top);
    ctx.fillStyle = "rgba(10,20,10,0.8)";
    ctx.fillRect(t.x, t.y - 3, t.w, 6);
    ctx.fillStyle = "rgba(156,195,135,0.55)";
    ctx.fillRect(t.x, t.y - 2, t.w * this.value, 4);
    ctx.strokeStyle = COLORS.line;
    ctx.strokeRect(t.x + 0.5, t.y - 2.5, t.w - 1, 5);
    const kx = t.x + t.w * this.value - 3;
    if (knob) ctx.drawImage(knob.frames[0], kx, top);
    else {
      ctx.fillStyle = COLORS.value;
      ctx.fillRect(kx, top, 6, 12);
    }
  }
  private set(v: number) {
    v = Math.max(0, Math.min(1, v));
    if (this.steps > 1) v = Math.round(v * (this.steps - 1)) / (this.steps - 1);
    if (v === this.value) return;
    this.value = v;
    this.onChange(v);
  }
  click(x: number, _y: number, menu: MenuCanvas) {
    const t = this.track();
    if (x < this.controlX - 4) return;
    if (x < t.x) this.step(-1);
    else if (x > t.x + t.w) this.step(1);
    else this.set((x - t.x) / t.w);
    menu.theme.audio.play("menu_k01");
  }
  drag(x: number) {
    const t = this.track();
    if (x >= this.controlX) this.set((x - t.x) / t.w);
  }
  step(dir: -1 | 1) {
    this.set(this.value + dir * (this.steps > 1 ? 1 / (this.steps - 1) : 0.05));
    return true;
  }
  wheel(dy: number) {
    this.step(dy > 0 ? -1 : 1);
  }
}

/** ToggleBox. */
export class Toggle extends OptionRow {
  value: boolean;
  onChange: (v: boolean) => void;
  constructor(
    rect: Rect,
    label: string,
    controlX: number,
    value: boolean,
    onChange: (v: boolean) => void,
  ) {
    super(rect, label, controlX);
    this.onChange = onChange;
    this.value = value;
  }
  drawControl(ctx: CanvasRenderingContext2D, theme: MenuTheme) {
    const box = { x: this.controlX, y: this.rect.y + this.rect.h / 2 - 7, w: 14, h: 14 };
    ctx.fillStyle = "rgba(10,20,10,0.8)";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    drawThinFrame(ctx, theme, box);
    if (this.value) {
      ctx.fillStyle = COLORS.value;
      ctx.fillRect(box.x + 4, box.y + 4, 6, 6);
    }
    theme.font1.draw(ctx, this.value ? "On" : "Off", box.x + 22, box.y + 7 - theme.font1.lineHeight / 2, { color: COLORS.value });
  }
  click(_x: number, _y: number, menu: MenuCanvas) {
    this.step();
    menu.theme.audio.play("menu_k02");
  }
  step() {
    this.value = !this.value;
    this.onChange(this.value);
    return true;
  }
}

/** A mission picture (PictureBox) with a thin frame. */
export class Picture extends Widget {
  sprite: Sprite | null;
  constructor(
    rect: Rect,
    sprite: Sprite | null,
  ) {
    super(rect);
    this.sprite = sprite;
  }
  draw(ctx: CanvasRenderingContext2D, theme: MenuTheme) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    if (this.sprite) ctx.drawImage(this.sprite.frames[0], this.rect.x + 2, this.rect.y + 2, this.rect.w - 4, this.rect.h - 4);
    drawThinFrame(ctx, theme, this.rect);
  }
}

export interface ListItem {
  text: string;
  enabled: boolean;
}

/** ScrollListBox: a framed list with a vertical slide bar; double-click or Enter activates. */
export class ListBox extends Widget {
  private offset = 0;
  private lastClick = 0;
  items: ListItem[];
  selected: number;
  rowHeight: number;
  onSelect: (i: number) => void;
  onActivate: (i: number) => void;
  constructor(
    rect: Rect,
    items: ListItem[],
    selected: number,
    onSelect: (i: number) => void,
    onActivate: (i: number) => void,
    rowHeight = 16,
  ) {
    super(rect);
    this.onSelect = onSelect;
    this.onActivate = onActivate;
    this.items = items;
    this.selected = selected;
    this.rowHeight = rowHeight;
    this.selectable = true;
  }
  private fit() {
    return Math.floor((this.rect.h - 8) / this.rowHeight);
  }
  draw(ctx: CanvasRenderingContext2D, theme: MenuTheme, focused: boolean) {
    ctx.fillStyle = "rgba(4,10,5,0.75)";
    ctx.fillRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    drawThinFrame(ctx, theme, this.rect);
    const fit = this.fit();
    this.offset = Math.max(0, Math.min(this.offset, this.items.length - fit));
    const f = theme.font4;
    for (let i = 0; i < fit && this.offset + i < this.items.length; i++) {
      const n = this.offset + i;
      const item = this.items[n];
      const y = this.rect.y + 4 + i * this.rowHeight;
      if (n === this.selected) {
        ctx.fillStyle = focused ? "rgba(156,195,135,0.35)" : "rgba(156,195,135,0.2)";
        ctx.fillRect(this.rect.x + 3, y, this.rect.w - 20, this.rowHeight);
      }
      f.draw(ctx, item.text, this.rect.x + 8, y + (this.rowHeight - f.lineHeight) / 2, { color: !item.enabled ? COLORS.disabled : n === this.selected ? COLORS.hover : COLORS.item });
    }
    // Vertical slide bar (slidevert_1 up, slidevert_2 down, slidevert_3 knob).
    if (this.items.length > fit) {
      const up = theme.sprites.get("slidevert_1");
      const down = theme.sprites.get("slidevert_2");
      const knob = theme.sprites.get("slidevert_3");
      const x = this.rect.x + this.rect.w - 15;
      if (up) ctx.drawImage(up.frames[0], x, this.rect.y + 3);
      if (down) ctx.drawImage(down.frames[0], x, this.rect.y + this.rect.h - 14);
      const span = this.rect.h - 28 - 22;
      const k = this.offset / Math.max(1, this.items.length - fit);
      if (knob) ctx.drawImage(knob.frames[0], x, this.rect.y + 14 + span * k);
    }
  }
  click(x: number, y: number) {
    const fit = this.fit();
    if (x > this.rect.x + this.rect.w - 16 && this.items.length > fit) {
      this.offset += y < this.rect.y + this.rect.h / 2 ? -1 : 1;
      return;
    }
    const n = this.offset + Math.floor((y - this.rect.y - 4) / this.rowHeight);
    if (n < 0 || n >= this.items.length || !this.items[n].enabled) return;
    const now = performance.now();
    if (n === this.selected && now - this.lastClick < 400) this.onActivate(n);
    else if (n !== this.selected) {
      this.selected = n;
      this.onSelect(n);
    }
    this.lastClick = now;
  }
  wheel(dy: number) {
    this.offset += dy;
  }
  key(e: KeyboardEvent) {
    if (e.code !== "ArrowUp" && e.code !== "ArrowDown" && e.code !== "Enter" && e.code !== "NumpadEnter") return false;
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      this.onActivate(this.selected);
      return true;
    }
    const dir = e.code === "ArrowUp" ? -1 : 1;
    let n = this.selected + dir;
    while (n >= 0 && n < this.items.length && !this.items[n].enabled) n += dir;
    if (n < 0 || n >= this.items.length) return false;
    this.selected = n;
    const fit = this.fit();
    if (n < this.offset) this.offset = n;
    if (n >= this.offset + fit) this.offset = n - fit + 1;
    this.onSelect(n);
    return true;
  }
}

/** A plain filled bar (loading progress), using status.res progressbar.spr as the frame when given. */
export class ProgressBar extends Widget {
  value = 0;
  frame: Sprite | null;
  constructor(
    rect: Rect,
    frame: Sprite | null,
  ) {
    super(rect);
    this.frame = frame;
  }
  draw(ctx: CanvasRenderingContext2D) {
    const r = this.rect;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "rgba(120,230,100,0.8)";
    ctx.fillRect(r.x + 4, r.y + 4, (r.w - 8) * Math.max(0, Math.min(1, this.value)), r.h - 8);
    if (this.frame) ctx.drawImage(this.frame.frames[0], r.x, r.y, r.w, r.h);
    else {
      ctx.strokeStyle = COLORS.line;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }
}
