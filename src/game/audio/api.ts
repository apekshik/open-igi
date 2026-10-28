import type { Vec3 } from "../coords.ts";

/** Volume buses. `master` scales everything; the others are the groups the options menu exposes. */
export type AudioBus = "master" | "effects" | "voice" | "music" | "ambience";

export interface SoundHandle {
  /** Stop with a short fade (seconds, default 0.03 to avoid clicks). Safe to call twice. */
  stop(fade?: number): void;
  /** Move a positional sound (world units). No effect on 2D sounds. */
  setPosition(p: Vec3): void;
  /** Set the level of this voice (0..1+), on top of the sound's own authored volume. */
  setVolume(v: number): void;
  /** False once the sound finished, was stopped or was stolen by a higher-priority voice. */
  readonly playing: boolean;
}

export interface PlayOptions {
  /** World position for 3D sound; omit for 2D (UI, player's own sounds). */
  at?: Vec3;
  volume?: number;
  loop?: boolean;
  /** Distance (world units) beyond which the sound is inaudible. Defaults to the sound's authored range. */
  range?: number;
  /** Playback rate multiplier (1 = as authored); handy for footstep variety. */
  pitch?: number;
  /** Which bus to route through. Defaults from the sound: dialogue to voice, music to music, otherwise effects. */
  bus?: Exclude<AudioBus, "master">;
  /** Voice-limit priority, higher survives (default by bus: music 100, voice 90, effects 50, ambience 20). */
  priority?: number;
  /** Keep playing while the game is paused (menu sounds). */
  ui?: boolean;
  /** Fade in over this many seconds. */
  fadeIn?: number;
  /** Called once when the sound ends for any reason. */
  onEnd?: () => void;
}

export interface AudioService {
  /**
   * Play a sound. `sound` is any of:
   *  - a game path, e.g. "common/sounds/wire_drag_1.wav" or "missions/location0/level1/sounds/m01_ing_01.wav"
   *    (case, slashes and a "LOCAL:" prefix do not matter),
   *  - a SoundDef name from sounds.qvm ("alarmsystem_working", "m1_heligen01"), which applies its volume, range and loop,
   *  - a bare file name ("jump_1", "m01_ing_01"), searched in the current level, then common, then everywhere.
   * Returns null if no such sound exists. Sounds not loaded yet start as soon as they are decoded.
   */
  play(sound: string, options?: PlayOptions): SoundHandle | null;
  /** All sound paths available (normalised: lowercase, forward slashes, no "LOCAL:"). */
  list(): string[];
  /** Sound paths whose path matches a substring (case-insensitive) or a RegExp. */
  find(pattern: string | RegExp): string[];
  /** The normalised path `sound` resolves to, or null. */
  resolve(sound: string): string | null;
  /** SoundDef names known for the current level (common/sounds/sounds.qvm plus the level's own). */
  defs(): string[];
  /** Decode these sounds now so the first play is instant. */
  preload(sounds: string[]): Promise<void>;
  /** Length in seconds (loads the sound if needed); null if it does not exist. */
  duration(sound: string): Promise<number | null>;

  /**
   * Play a mission dialogue / radio line on the voice bus. Lines queue and play one after another unless
   * `interrupt` is set. Resolves when the line has finished (or was dropped). Resolves immediately if missing.
   */
  speak(line: string, options?: { interrupt?: boolean; volume?: number }): Promise<void>;
  /** Stop the current dialogue line and clear the queue. */
  stopSpeech(): void;
  /** Play looping-by-default music (e.g. "menu_music") on the music bus, replacing the current track. */
  playMusic(sound: string, options?: { loop?: boolean; fade?: number; volume?: number; ui?: boolean }): SoundHandle | null;
  stopMusic(fade?: number): void;

  /** Bus volumes 0..1 for the options menu. Saved to localStorage. */
  getVolume(bus: AudioBus): number;
  setVolume(bus: AudioBus, v: number): void;
  readonly muted: boolean;
  setMuted(muted: boolean): void;

  /**
   * Hook for task variables used in level sound conditions ("AlarmControl_98.isAlarm", "CutScene_1200.nTick",
   * "EditVariable_4004.nValue"). Return undefined for names you do not know. The mission system installs this; without it,
   * only alarm state (from the `alarm` event) and ConditionalContainer state are known.
   */
  setVariableResolver(resolve: ((name: string) => number | boolean | undefined) | null): void;
  /** "running" once the browser let audio start (after a user gesture), else "locked". */
  readonly state: "locked" | "running";
  /** Try to start audio; call from a click/key handler if the game has its own start button. */
  resume(): void;
  /** State of the level's AmbientArea / ConditionalSound tasks and their containers. */
  level(): { areas: object[]; conditional: object[]; containers: object[] };
  /** Debug counters (level is the RMS of the output mix). */
  voices(): { path: string; bus: string; state: string; loop: boolean; priority: number; volume: number; distanceM: number | null; pan: number | null }[];
  stats(): { level: number; voices: number; pending: number; cached: number; cachedMB: number; areas: number; conditional: number };
}
