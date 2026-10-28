/** Context actions IGI shows an icon for when Jones can use something (status.res a_* / action_* sprites). */
export type HudAction = "door" | "ladder" | "fence" | "wire" | "c4" | "gun" | "computer" | "picklock" | "cabinet" | "button";

export interface HudService {
  /** Show a short message (also triggered by "message" events). */
  message(text: string, seconds?: number): void;
  /** Hide all HUD (cutscenes, map computer). */
  visible: boolean;
  /** Show the icon for what the "use" key would do here, or null for nothing. */
  action(kind: HudAction | null): void;
  /** Show a progress bar for a timed action (planting C4, hacking a computer), 0..1; null hides it. */
  progress(value: number | null, label?: string): void;
  /** True while the map computer is open (the player is frozen and the mouse is released). */
  readonly mapOpen: boolean;
  /** Open or close the map computer (the map key toggles it too). */
  setMapOpen(open: boolean): void;
}

/** Optics the weapons system reports through the "weapon:zoom" event. */
export type ZoomMode = "none" | "binoculars" | "scope";

declare module "../events.ts" {
  interface GameEvents {
    /** The player raised or lowered binoculars or a scope; `zoom` is the magnification (1 = none). */
    "weapon:zoom": { mode: ZoomMode; zoom: number };
  }
}
