// STUB audio: silent. The audio system replaces it with positional Web Audio playback of the game's sounds,
// ambience areas, conditional sounds, dialogue and music.
import type { GameSystem } from "../game.ts";

export function audioSystem(): GameSystem {
  return {
    name: "audio",
    init(game) {
      game.services.audio = { play: () => null, list: () => [] };
    },
  };
}
