// ?view=play&level=level1: run the game. The UI workstream replaces this with the full front end (menus, mission
// select, briefing) in src/ui/.
import { Game } from "../game/game.ts";
import { createSystems } from "../game/systems.ts";
import type { Vfs } from "../vfs/vfs.ts";

export async function playView(vfs: Vfs, _toolbar: HTMLElement, host: HTMLElement, status: (s: string) => void) {
  const params = new URLSearchParams(location.search);
  const game = await Game.start({
    vfs,
    host,
    level: params.get("level") ?? "level1",
    systems: createSystems(),
    detail: Number(params.get("detail") ?? 4),
    onProgress: status,
  });
  status(`${game.level.name} | click to capture the mouse, Esc to release`);
  if (import.meta.env.DEV) Object.assign(window, { game });
}
