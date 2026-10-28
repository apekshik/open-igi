// STUB weapons: none. The weapons system replaces it with IGI's weapons (stats from weapons/*.qvm, first-person
// models and animations, hitscan shooting, reloads, pickups, binoculars and scopes).
import type { GameSystem } from "../game.ts";

export function weaponsSystem(): GameSystem {
  return { name: "weapons" };
}
