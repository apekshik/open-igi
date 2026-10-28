import type { Vec3 } from "../coords.ts";

export interface SoundHandle {
  stop(): void;
  setPosition(p: Vec3): void;
}

export interface PlayOptions {
  /** World position for 3D sound; omit for 2D (UI, player's own sounds). */
  at?: Vec3;
  volume?: number;
  loop?: boolean;
  /** Distance (world units) beyond which the sound is inaudible. */
  range?: number;
}

export interface AudioService {
  /**
   * Play a sound by its game path, e.g. "common/sounds/wire_drag_1.wav" (inside sounds.res) or
   * "missions/location0/level1/sounds/m01_ing_01.wav". Returns null if it does not exist.
   */
  play(sound: string, options?: PlayOptions): SoundHandle | null;
  /** All sound paths available. */
  list(): string[];
}
