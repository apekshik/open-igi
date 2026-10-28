// Cross-system services. Each system publishes its service on `game.services` in init(); other systems use them
// only through these interfaces (and events), so systems can be developed and replaced independently.
// Each interface lives in its system's api.ts; extend your own api.ts freely.

import type { AiService } from "./ai/api.ts";
import type { AudioService } from "./audio/api.ts";
import type { HudService } from "./hud/api.ts";
import type { MissionService } from "./mission/api.ts";
import type { PhysicsService } from "./physics/api.ts";
import type { PlayerService } from "./player/api.ts";
import type { WeaponsService } from "./weapons/api.ts";
import type { WorldService } from "./world/api.ts";

export interface Services {
  physics?: PhysicsService;
  world?: WorldService;
  player?: PlayerService;
  weapons?: WeaponsService;
  ai?: AiService;
  mission?: MissionService;
  audio?: AudioService;
  hud?: HudService;
}
