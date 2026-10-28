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
   * Spawn a character that was not spawned at level start (cutscene and vehicle passengers are left to the mission
   * system), by its HumanSoldier task id. Returns the existing one if it is already in play.
   */
  spawn(taskId: number): AiCharacter | undefined;
  /** How many guards a GuardGenerator task has spawned so far (its nSpawns). */
  generatorSpawns(taskId: number): number;
  /** Send an AI event to a character (as the engine would), e.g. "AIEVENT_ANIMATION" with an animation id. */
  send(entityId: number, event: AiEvent, options?: { position?: Vec3; animation?: number }): void;
  /** Whether the base alarm is sounding (from "alarm" events). */
  readonly alarm: boolean;
  /**
   * Route over an AIGraph (graphs/graph<id>.dat) from the node nearest `from` to node `toNode`, as node positions,
   * for vehicles driven by CarAI tasks along PatrolPaths. undefined while the graph is still loading, null if unknown.
   */
  graphRoute?(graphId: number, from: Vec3, toNode: number): Vec3[] | null | undefined;
  /** Show a marker over each character, coloured by state and sized by awareness (also ?aidebug). */
  debug: boolean;
}
