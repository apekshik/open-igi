// STUB mission: none. The mission system replaces it with objectives, level flow, triggers, timers, alarms, doors,
// terminals and the win/lose conditions from the level's scripts and language files.
import type { GameSystem } from "../game.ts";

export function missionSystem(): GameSystem {
  return { name: "mission" };
}
