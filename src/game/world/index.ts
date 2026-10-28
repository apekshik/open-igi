// STUB world: flat background colour and fog. The world system replaces it with IGI's sky layers, sun/ambient light
// from GlobalLight, building lightmaps (.olm), model LODs and moving scenery.
import * as THREE from "three";
import { METRE } from "../coords.ts";
import type { GameSystem } from "../game.ts";

export function worldSystem(): GameSystem {
  return {
    name: "world",
    init(game) {
      const fog = { color: 0x9aa7b4, near: 300 * METRE, far: 4000 * METRE };
      game.scene.background = new THREE.Color(fog.color);
      game.scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
      game.services.world = { fog };
    },
  };
}
