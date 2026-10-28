// The game's systems, in update order. Each lives in src/game/<name>/index.ts and is owned by one workstream;
// replace a system's implementation there rather than editing this list.
import { aiSystem } from "./ai/index.ts";
import { audioSystem } from "./audio/index.ts";
import type { GameSystem } from "./game.ts";
import { hudSystem } from "./hud/index.ts";
import { missionSystem } from "./mission/index.ts";
import { physicsSystem } from "./physics/index.ts";
import { playerSystem } from "./player/index.ts";
import { weaponsSystem } from "./weapons/index.ts";
import { worldSystem } from "./world/index.ts";

export function createSystems(): GameSystem[] {
  return [physicsSystem(), worldSystem(), audioSystem(), playerSystem(), weaponsSystem(), aiSystem(), missionSystem(), hudSystem()];
}
