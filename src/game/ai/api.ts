import type { Entity } from "../entity.ts";

export type AiState = "idle" | "patrol" | "alert" | "search" | "combat" | "dead";

export interface AiService {
  /** All AI-controlled characters in the level. */
  characters(): (Entity & { state: AiState })[];
}
