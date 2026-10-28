// ?view=play: the game with IGI's front end (main menu, mission select, options, loading screen, pause and end
// screens; see src/ui/app.ts). ?level=levelN skips the menus and starts that mission directly; ?detail=N overrides
// the terrain detail; ?missions=all unlocks every mission in the mission select.
import { FrontEnd } from "../ui/app.ts";
import type { Vfs } from "../vfs/vfs.ts";

export async function playView(vfs: Vfs, _toolbar: HTMLElement, host: HTMLElement, status: (s: string) => void) {
  const params = new URLSearchParams(location.search);
  const frontEnd = new FrontEnd(vfs, host, status);
  if (import.meta.env.DEV) Object.assign(window, { frontEnd });
  await frontEnd.start(params.get("level") ?? undefined);
}
