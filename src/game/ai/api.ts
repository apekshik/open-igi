import type { Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";

export type AiState = "idle" | "patrol" | "alert" | "search" | "combat" | "dead";

/** IGI's AI events (AIEVENT_* in the scripts). */
export type AiEvent =
  | "AIEVENT_ALARMOFF" | "AIEVENT_ALARMON" | "AIEVENT_ALERT" | "AIEVENT_ALERT_RESPONSE" | "AIEVENT_ANIMATION"
  | "AIEVENT_COMBAT" | "AIEVENT_CREATE" | "AIEVENT_DEAD" | "AIEVENT_DELETE" | "AIEVENT_DOOR" | "AIEVENT_ENEMYDETECTION"
  | "AIEVENT_EXPLOSION" | "AIEVENT_FENCE" | "AIEVENT_FLASHBANG" | "AIEVENT_FRIENDLYDETECTION" | "AIEVENT_GRENADELAND"
  | "AIEVENT_GRENADETHROWN" | "AIEVENT_GROUNDIMPACT" | "AIEVENT_GUNSHOT" | "AIEVENT_GUNSHOTMISS" | "AIEVENT_IDLE"
  | "AIEVENT_LADDER" | "AIEVENT_TAKINGDAMAGE" | "AIEVENT_WALK";

/**
 * IGI's game difficulty (GOGameDiff in config.qvm: GD_1, GD_2 = the shipped default, GD_3). Every AI type has one
 * HumanAIConfigItem per difficulty in common/ai/settings.qvm (damage scale, accuracy, bursts, reaction delays, grenades).
 */
export type AiDifficulty = "easy" | "normal" | "hard";

export interface AiCharacter extends Entity {
  state: AiState;
  /** "AITYPE_PATROL_AK", ... */
  aiType: string;
  /** HumanAI task id (its script is ai/<id>.qvm). */
  aiId: number;
  /** 0..1: how close this character is to noticing its target (1 = detected). */
  awareness: number;
}

export interface AiService {
  /** All AI-controlled characters in the level. */
  characters(): AiCharacter[];
  /** The character spawned from a HumanSoldier task id. */
  byTask(taskId: number): AiCharacter | undefined;
  /**
   * Spawn a character that was not spawned at level start, by its HumanSoldier task id. Returns the existing one if it
   * is already in play. Characters placed inside cutscenes and vehicles (Heli, Car, Train, AnimTask) spawn only
   * through this call, passive by default (no senses, no fighting): pass `passenger.anchor` to carry them with their
   * vehicle (called every frame; feet position and heading in IGI units, or null to leave them where they are), or
   * `passive: false` to let them fight. Like every character inside a ConditionalContainer, they leave play when
   * the container stops.
   */
  spawn(taskId: number, options?: { passive?: boolean; passenger?: { anchor: () => { position: Vec3; yaw: number } | null } }): AiCharacter | undefined;
  /** Remove a character from play (as IGI does when its ConditionalContainer stops). */
  despawn(taskId: number): void;
  /** How many guards a GuardGenerator task has spawned so far (its nSpawns). */
  generatorSpawns(taskId: number): number;
  /** Send an AI event to a character (as the engine would), e.g. "AIEVENT_ANIMATION" with an animation id. */
  send(entityId: number, event: AiEvent, options?: { position?: Vec3; animation?: number }): void;
  /** Whether the base alarm is sounding (from "alarm" events). */
  readonly alarm: boolean;
  /**
   * Game difficulty: picks each AI type's settings.qvm row (GD_1/GD_2/GD_3). Starts from `?difficulty=` (1-3 or
   * easy/normal/hard), default normal; setting it applies to soldiers already in play.
   */
  difficulty: AiDifficulty;
  /** Milliseconds the AI took in its last update (all soldiers), for profiling. */
  readonly frameTime: number;
  /** Show a marker over each character, coloured by state and sized by awareness (also ?aidebug). */
  debug: boolean;
}

declare module "../events.ts" {
  interface GameEvents {
    /** A soldier threw a grenade or flashbang (launch velocity in units/s, fuse in seconds). */
    "ai:grenade": { entityId: number; weapon: string; origin: Vec3; velocity: Vec3; fuse: number };
  }
}
