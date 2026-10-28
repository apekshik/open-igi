// STUB AI: none. The AI system replaces it with the level's soldiers and civilians (HumanSoldier/HumanAI tasks),
// skinned and animated, patrolling, perceiving the player, fighting, raising alarms and dying.
import type { GameSystem } from "../game.ts";

export function aiSystem(): GameSystem {
  return { name: "ai" };
}
