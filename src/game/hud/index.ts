// STUB HUD: plain text overlay for messages, health and objectives. The UI system replaces it with IGI's HUD
// (status textures, ammo, compass), map computer, binocular overlay and menus.
import type { GameSystem } from "../game.ts";

export function hudSystem(): GameSystem {
  let box: HTMLDivElement;
  let status: HTMLDivElement;
  return {
    name: "hud",
    init(game) {
      box = Object.assign(document.createElement("div"), { style: "position:absolute;left:50%;top:20%;transform:translateX(-50%);color:#fff;font:16px monospace;text-shadow:0 0 4px #000;pointer-events:none" });
      status = Object.assign(document.createElement("div"), { style: "position:absolute;left:16px;bottom:16px;color:#cfe;font:14px monospace;text-shadow:0 0 4px #000;pointer-events:none;white-space:pre" });
      game.overlay.append(box, status);
      let timer = 0;
      const message = (text: string, seconds = 3) => {
        box.textContent = text;
        clearTimeout(timer);
        timer = window.setTimeout(() => (box.textContent = ""), seconds * 1000);
      };
      game.events.on("message", (m) => message(m.text, m.seconds));
      game.services.hud = { message, visible: true };
    },
    update(_dt, game) {
      const p = game.services.player?.entity;
      const w = game.services.weapons?.current();
      status.textContent = `${p ? `HEALTH ${Math.round(p.health)}` : ""}${w ? `   ${w.name} ${w.clip}/${w.reserve}` : ""}\n${game.input.locked ? "" : "click to play"}`;
    },
  };
}
