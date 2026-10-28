// The key-binding list of the Controls screen (IGI's ControlsMenu): one row per action with its key; click a row,
// then press a key, mouse button or turn the wheel to rebind it.
import type { Action } from "../game/input.ts";
import { COLORS, drawThinFrame, Widget, type MenuCanvas, type MenuTheme, type Rect } from "./menu.ts";

/** Actions in the order the Controls screen lists them, with the language-file key for the label when IGI has one. */
export const ACTION_LABELS: [Action, string, string][] = [
  ["forward", "MoveUp", "Move Forwards"],
  ["back", "MoveDown", "Move Backwards"],
  ["left", "MoveLeft", "Move Left"],
  ["right", "MoveRight", "Move Right"],
  ["walk", "ToggleWalkRun", "Walk"],
  ["jump", "Jump", "Jump"],
  ["crouch", "Crouch", "Crouch"],
  ["prone", "", "Prone"],
  ["leanLeft", "", "Peek Left"],
  ["leanRight", "", "Peek Right"],
  ["fire", "Fire", "Fire"],
  ["aim", "AlternateFire", "Aim / Zoom"],
  ["reload", "Reload", "Reload"],
  ["use", "Activate", "Activate"],
  ["nextWeapon", "NextWeapon", "Next Weapon"],
  ["prevWeapon", "PrevWeapon", "Previous Weapon"],
  ["weapon1", "", "Weapon 1"],
  ["weapon2", "", "Weapon 2"],
  ["weapon3", "", "Weapon 3"],
  ["weapon4", "", "Weapon 4"],
  ["weapon5", "", "Weapon 5"],
  ["binoculars", "Binoculars", "Binoculars"],
  ["map", "MapComputer", "Mapcomputer"],
  ["pause", "", "Pause Menu"],
];

const NAMED: Record<string, string> = {
  Space: "Space bar",
  Enter: "Return",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Esc",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  ControlLeft: "Left Control",
  ControlRight: "Right Control",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  ArrowUp: "Arrow Up",
  ArrowDown: "Arrow Down",
  ArrowLeft: "Arrow Left",
  ArrowRight: "Arrow Right",
  BracketLeft: "[",
  BracketRight: "]",
  Mouse0: "Left Mousebutton",
  Mouse1: "Middle Mousebutton",
  Mouse2: "Right Mousebutton",
  Mouse3: "Mousebutton 4",
  Mouse4: "Mousebutton 5",
  WheelUp: "Wheel Up",
  WheelDown: "Wheel Down",
};

/** Human name for a KeyboardEvent.code / Input binding code. */
export function keyName(code: string): string {
  if (NAMED[code]) return NAMED[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Numpad ${code.slice(6)}`;
  return code.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export class KeyBindings extends Widget {
  private offset = 0;
  private selected = 0;
  private capturing = false;
  private stopCapture: (() => void) | null = null;
  private rowHeight = 15;

  bindings: Record<Action, string[]>;
  private labels: Map<string, string>;
  private onChange: () => void;
  constructor(
    rect: Rect,
    bindings: Record<Action, string[]>,
    labels: Map<string, string>,
    onChange: () => void,
  ) {
    super(rect);
    this.onChange = onChange;
    this.bindings = bindings;
    this.labels = labels;
    this.selectable = true;
  }

  private fit() {
    return Math.floor((this.rect.h - 8) / this.rowHeight);
  }

  draw(ctx: CanvasRenderingContext2D, theme: MenuTheme, focused: boolean) {
    const r = this.rect;
    ctx.fillStyle = "rgba(4,10,5,0.75)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    drawThinFrame(ctx, theme, r);
    const fit = this.fit();
    this.offset = Math.max(0, Math.min(this.offset, ACTION_LABELS.length - fit));
    const f = theme.font4;
    for (let i = 0; i < fit && this.offset + i < ACTION_LABELS.length; i++) {
      const n = this.offset + i;
      const [action, key, fallback] = ACTION_LABELS[n];
      const y = r.y + 4 + i * this.rowHeight;
      const isSel = n === this.selected;
      if (isSel) {
        ctx.fillStyle = focused ? "rgba(156,195,135,0.33)" : "rgba(156,195,135,0.15)";
        ctx.fillRect(r.x + 3, y, r.w - 20, this.rowHeight);
      }
      const ty = y + (this.rowHeight - f.lineHeight) / 2;
      f.draw(ctx, (key && this.labels.get(key)) || fallback, r.x + 8, ty, { color: isSel ? COLORS.hover : COLORS.item });
      const value = isSel && this.capturing ? this.labels.get("Select a key or button") ?? "Select a key or button" : (this.bindings[action] ?? []).map(keyName).join(", ") || "-";
      f.draw(ctx, value, r.x + r.w - 22, ty, { color: isSel && this.capturing ? COLORS.hover : COLORS.value, align: "right" });
    }
    const x = r.x + r.w - 15;
    const up = theme.sprites.get("slidevert_1");
    const down = theme.sprites.get("slidevert_2");
    const knob = theme.sprites.get("slidevert_3");
    if (up) ctx.drawImage(up.frames[0], x, r.y + 3);
    if (down) ctx.drawImage(down.frames[0], x, r.y + r.h - 14);
    const k = this.offset / Math.max(1, ACTION_LABELS.length - fit);
    if (knob) ctx.drawImage(knob.frames[0], x, r.y + 14 + (r.h - 50) * k);
  }

  click(x: number, y: number, menu: MenuCanvas) {
    if (this.capturing) return;
    if (x > this.rect.x + this.rect.w - 16) {
      this.offset += y < this.rect.y + this.rect.h / 2 ? -3 : 3;
      return;
    }
    const n = this.offset + Math.floor((y - this.rect.y - 4) / this.rowHeight);
    if (n < 0 || n >= ACTION_LABELS.length) return;
    this.selected = n;
    menu.theme.audio.play("menu_sel");
    this.capture();
  }

  /** Wait for the next key, mouse button or wheel turn and bind it to the selected action. */
  private capture() {
    this.capturing = true;
    // Skip the click that started the capture.
    const armed = performance.now() + 150;
    const bind = (code: string) => {
      this.stopCapture?.();
      if (code !== "Escape") {
        const action = ACTION_LABELS[this.selected][0];
        for (const a of Object.keys(this.bindings) as Action[]) this.bindings[a] = this.bindings[a].filter((c) => c !== code);
        this.bindings[action] = [code];
        this.onChange();
      }
    };
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      bind(e.code);
    };
    const mouse = (e: MouseEvent) => {
      if (performance.now() < armed) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      bind(`Mouse${e.button}`);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      bind(e.deltaY > 0 ? "WheelDown" : "WheelUp");
    };
    addEventListener("keydown", key, { capture: true });
    addEventListener("mousedown", mouse, { capture: true });
    addEventListener("wheel", wheel, { capture: true, passive: false });
    this.stopCapture = () => {
      removeEventListener("keydown", key, { capture: true });
      removeEventListener("mousedown", mouse, { capture: true });
      removeEventListener("wheel", wheel, { capture: true });
      this.capturing = false;
      this.stopCapture = null;
    };
  }

  wheel(dy: number) {
    if (!this.capturing) this.offset += dy * 2;
  }

  key(e: KeyboardEvent) {
    if (this.capturing) return true;
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      this.capture();
      return true;
    }
    if (e.code !== "ArrowUp" && e.code !== "ArrowDown") return false;
    const n = this.selected + (e.code === "ArrowUp" ? -1 : 1);
    if (n < 0 || n >= ACTION_LABELS.length) return false;
    this.selected = n;
    const fit = this.fit();
    if (n < this.offset) this.offset = n;
    if (n >= this.offset + fit) this.offset = n - fit + 1;
    return true;
  }

  dispose() {
    this.stopCapture?.();
  }
}
