// Keyboard and mouse input with pointer lock, mapped to named actions. Defaults follow IGI's PC controls where
// sensible; the UI can rebind via `bindings`.

export type Action =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "leanLeft"
  | "leanRight"
  | "jump"
  | "crouch"
  | "prone"
  | "walk"
  | "fire"
  | "aim"
  | "reload"
  | "use"
  | "nextWeapon"
  | "prevWeapon"
  | "binoculars"
  | "map"
  | "pause"
  | "weapon1"
  | "weapon2"
  | "weapon3"
  | "weapon4"
  | "weapon5"
  | "weapon6"
  | "weapon7"
  | "weapon8"
  | "weapon9";

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  leanLeft: ["KeyQ"],
  leanRight: ["KeyE"],
  jump: ["Space"],
  crouch: ["KeyC", "ControlLeft"],
  prone: ["KeyZ"],
  walk: ["ShiftLeft"],
  fire: ["Mouse0"],
  aim: ["Mouse2"],
  reload: ["KeyR"],
  use: ["KeyF"],
  nextWeapon: ["WheelDown", "BracketRight"],
  prevWeapon: ["WheelUp", "BracketLeft"],
  binoculars: ["KeyB"],
  map: ["KeyM", "Tab"],
  pause: ["Escape", "KeyP"],
  weapon1: ["Digit1"],
  weapon2: ["Digit2"],
  weapon3: ["Digit3"],
  weapon4: ["Digit4"],
  weapon5: ["Digit5"],
  weapon6: ["Digit6"],
  weapon7: ["Digit7"],
  weapon8: ["Digit8"],
  weapon9: ["Digit9"],
};

export class Input {
  bindings: Record<Action, string[]> = structuredClone(DEFAULT_BINDINGS);
  /** Mouse sensitivity in radians per pixel. */
  sensitivity = 0.0022;
  /** Invert vertical mouse look (options menu). */
  invertY = false;
  private down = new Set<string>();
  private pressed = new Set<string>();
  private mouse = { dx: 0, dy: 0 };
  private element: HTMLElement;
  private cleanup: (() => void)[] = [];

  constructor(element: HTMLElement) {
    this.element = element;
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, target: EventTarget = window) => {
      target.addEventListener(type, fn as EventListener, { passive: false });
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
    };
    const press = (code: string) => {
      if (!this.down.has(code)) this.pressed.add(code);
      this.down.add(code);
    };
    on("keydown", (e) => {
      if (e.code === "Tab") e.preventDefault();
      if (!e.repeat) press(e.code);
    });
    on("keyup", (e) => this.down.delete(e.code));
    on("blur", () => this.down.clear());
    on("mousedown", (e) => {
      if (this.locked) press(`Mouse${e.button}`);
    });
    on("mouseup", (e) => this.down.delete(`Mouse${e.button}`));
    on("contextmenu", (e) => e.preventDefault(), element);
    on("mousemove", (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });
    on("wheel", (e) => {
      if (!this.locked) return;
      this.pressed.add(e.deltaY > 0 ? "WheelDown" : "WheelUp");
    });
    on("click", () => this.lock(), element);
  }

  get locked() {
    return document.pointerLockElement === this.element;
  }

  lock() {
    if (!this.locked) this.element.requestPointerLock?.()?.catch?.(() => {});
  }

  unlock() {
    if (this.locked) document.exitPointerLock();
  }

  /** Held this frame. */
  isDown(action: Action): boolean {
    return this.bindings[action].some((c) => this.down.has(c));
  }

  /** Went down since the last frame. */
  wasPressed(action: Action): boolean {
    return this.bindings[action].some((c) => this.pressed.has(c));
  }

  /** Mouse movement since the last frame, in radians (x: yaw, y: pitch). */
  look(): { yaw: number; pitch: number } {
    return { yaw: -this.mouse.dx * this.sensitivity, pitch: (this.invertY ? 1 : -1) * this.mouse.dy * this.sensitivity };
  }

  /** Called by the game at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.mouse.dx = this.mouse.dy = 0;
  }

  dispose() {
    for (const c of this.cleanup) c();
  }
}
