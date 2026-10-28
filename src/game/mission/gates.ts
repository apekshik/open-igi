// ConditionalContainer gating for things other systems own (static models, their collision): in IGI a container's
// subtree only exists while the container runs. `gates` are the container task ids around the object
// (Placement.gates). Without a mission system everything exists, as before.
import type { Game } from "../game.ts";

export function gatesOpen(game: Game, gates: readonly number[] | undefined): boolean {
  const mission = game.services.mission;
  if (!gates?.length || !mission) return true;
  return gates.every((id) => Number(mission.evaluate(`ConditionalContainer_${id}.isRun`)) !== 0);
}
