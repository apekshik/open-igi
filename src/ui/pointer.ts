// The mouse-capture and pause rules of a running mission, as a small state machine with no DOM access so it can be
// unit-tested (src/ui/pointer.test.ts). The front end (src/ui/app.ts) feeds it browser events and carries out the
// commands it returns.
//
// - Starting or resuming asks for pointer lock. Browsers may refuse (no user gesture, the ~1 s cooldown after the
//   player pressed Esc to leave pointer lock, iframes without allow-pointer-lock): play then continues with a
//   "click to capture the mouse" hint, and a click on the game view captures it (src/game/input.ts).
// - Losing the pointer while playing pauses, unless the map computer released it. Esc in pointer lock reaches the
//   page only as a pointer-lock change, so this is how Esc pauses.
// - Window blur or a hidden tab pauses.
// - The pause key pauses, except right after resuming: the same Esc press that resumed from the pause menu
//   reaches the game's input too and must not pause again.

export type FlowEvent =
  /** The player chose to play (loading screen click, Resume, Esc in the pause menu). */
  | { type: "resume"; now: number }
  /** A menu or end screen took over (pause menu, game over, quit). */
  | { type: "stop" }
  | { type: "locked" }
  | { type: "unlocked" }
  /** requestPointerLock was refused. */
  | { type: "lockError" }
  /** The window lost focus or the tab was hidden. */
  | { type: "blur" }
  /** The pause action was pressed in the game. */
  | { type: "pauseKey"; now: number }
  | { type: "map"; open: boolean };

export type FlowCommand = "pause" | "lock" | "unlock";

/** Ignore the pause key this long after resuming (ms). */
export const RESUME_GRACE = 250;

export class PointerFlow {
  playing = false;
  locked = false;
  mapOpen = false;
  private resumedAt = -Infinity;

  /** Show "click to capture the mouse": playing, not on the map computer, and the pointer is not ours. */
  get hint(): boolean {
    return this.playing && !this.mapOpen && !this.locked;
  }

  handle(e: FlowEvent): FlowCommand[] {
    switch (e.type) {
      case "resume":
        this.playing = true;
        this.mapOpen = false;
        this.resumedAt = e.now;
        return this.locked ? [] : ["lock"];
      case "stop":
        this.playing = false;
        return this.locked ? ["unlock"] : [];
      case "locked":
        this.locked = true;
        // Captured while a menu is up (a stray request resolving late): give it back.
        return this.playing && !this.mapOpen ? [] : ["unlock"];
      case "unlocked":
        this.locked = false;
        return this.playing && !this.mapOpen ? this.pause() : [];
      case "lockError":
        this.locked = false;
        return [];
      case "blur":
        return this.playing && !this.mapOpen ? this.pause() : [];
      case "pauseKey":
        if (!this.playing || this.mapOpen || e.now - this.resumedAt < RESUME_GRACE) return [];
        return this.pause();
      case "map":
        // The map computer releases and recaptures the pointer itself (src/game/hud).
        this.mapOpen = e.open;
        return [];
    }
  }

  private pause(): FlowCommand[] {
    this.playing = false;
    return this.locked ? ["unlock", "pause"] : ["pause"];
  }
}
