// Player settings (the Configuration menu) and mission progress, kept in localStorage and applied to a running Game.
import type { AudioService } from "../game/audio/api.ts";
import type { Game } from "../game/game.ts";
import { DEFAULT_BINDINGS, type Action } from "../game/input.ts";

export interface Settings {
  /** Mouse sensitivity slider, 0..1 (mapped to radians per pixel by `mouseRadians`). */
  mouse: number;
  invertMouse: boolean;
  bindings: Record<Action, string[]>;
  /** 0..1 */
  musicVolume: number;
  fxVolume: number;
  /** Graphics detail slider index into DETAIL_LEVELS. */
  detail: number;
}

/** Terrain level-of-detail multipliers for Game.start({ detail }) from "High speed" to "High detail". */
export const DETAIL_LEVELS = [1, 2, 3, 4, 6, 8];

const KEY = "open-igi:settings";
const PROGRESS_KEY = "open-igi:progress";

export function defaultSettings(): Settings {
  return { mouse: 0.32, invertMouse: false, bindings: structuredClone(DEFAULT_BINDINGS), musicVolume: 0.7, fxVolume: 0.9, detail: 3 };
}

export function loadSettings(): Settings {
  const s = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    Object.assign(s, saved, { bindings: { ...s.bindings, ...(saved.bindings ?? {}) } });
  } catch {
    // Private mode or corrupt data: defaults.
  }
  s.detail = Math.max(0, Math.min(DETAIL_LEVELS.length - 1, Math.round(s.detail)));
  return s;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not persisted; settings still apply for this session.
  }
}

/** Slider 0..1 → radians per pixel (default 0.32 ≈ the engine default 0.0022). */
export function mouseRadians(v: number): number {
  return 0.0004 + v * 0.0056;
}

/** Push settings into a running game: input now, volumes through the audio service if it supports them. */
export function applySettings(game: Game, s: Settings) {
  game.input.sensitivity = mouseRadians(s.mouse);
  game.input.invertY = s.invertMouse;
  game.input.bindings = structuredClone(s.bindings);
  const audio = game.services.audio as (AudioService & { setVolume?(bus: string, v: number): void }) | undefined;
  if (audio?.setVolume) {
    audio.setVolume("music", s.musicVolume);
    for (const bus of ["effects", "voice", "ambience"]) audio.setVolume(bus, s.fxVolume);
  }
}

/** Highest mission number the player may start (1-based); IGI unlocks missions in order. */
export function missionsUnlocked(): number {
  try {
    return Math.max(1, Math.min(14, Number(localStorage.getItem(PROGRESS_KEY)) || 1));
  } catch {
    return 1;
  }
}

export function unlockMission(n: number) {
  if (n <= missionsUnlocked()) return;
  try {
    localStorage.setItem(PROGRESS_KEY, String(Math.min(14, n)));
  } catch {
    // ignore
  }
}
