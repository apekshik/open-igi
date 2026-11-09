// The level's climbable fences. IGI's Fence task (position, gamma, model, electric expression) places a chain-link panel
// that Jones climbs over with clip 171 of 000.iff: 6 s at the clip's rate, hauling himself up hand over hand until the
// pelvis is 3.85 m up, swinging over and dropping, ending 1.49 m forward of where he started with the pelvis 0.64 m
// above a standing one (the drop finishes as a fall). Mission 1's "It looks like you can climb the fence into the next
// section" (M1 ClimbableFences) is one; Missions 5, 7 and 11 place more.
//
// The panels (302_01_1, 302_02_1, 370_01_1, 370_02_1) run along model X from 0, are 0.14 m thick about model Y = 0 and
// 3.9 m tall: the height clip 171 is made for. Mission 7's 2 m 331_01_1 is a Fence task too, but the clip would climb
// air there, so only panels at least FENCE_MIN_HEIGHT tall are climbable. A fence whose electric expression holds
// (Mission 6 until its generator is shut down) is not climbed.
import * as THREE from "three";
import { METRE, type Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";

/** Shortest panel clip 171 fits (its hands reach about 3.9 m). */
const FENCE_MIN_HEIGHT = 3.5 * METRE;

export interface Fence {
  model: string;
  /** World position (absolute IGI units) of the model origin: the panel's foot at its start. */
  origin: Vec3;
  /** Horizontal unit vectors of model X (along the panel) and model Y (its normal). */
  along: [number, number];
  normal: [number, number];
  /** Model X extent of the panel (units). */
  start: number;
  end: number;
  /** Height of the panel's top above its origin. */
  top: number;
  /** The task's electric expression ("" for a dead fence). */
  electric: string;
}

/** Find every climbable fence placed in the level. */
export function findFences(game: Game): Fence[] {
  const out: Fence[] = [];
  const sizes = new Map<string, THREE.Box3 | null>();
  const m = new THREE.Matrix4();
  for (const object of game.staticObjects) {
    const placement = object.userData.placement as { type?: string; model?: string; electric?: string } | undefined;
    if (placement?.type !== "Fence" || !placement.model) continue;
    const model = placement.model;
    if (!sizes.has(model)) {
      const built = game.level.library.build(model);
      if (built && !built.geometry.boundingBox) built.geometry.computeBoundingBox();
      sizes.set(model, built?.geometry.boundingBox?.clone() ?? null);
    }
    const box = sizes.get(model);
    if (!box || box.max.z - Math.max(0, box.min.z) < FENCE_MIN_HEIGHT) continue;
    if (object.matrixAutoUpdate) object.updateMatrix();
    m.copy(object.matrix);
    const e = m.elements;
    const ax = Math.hypot(e[0], e[1]), ny = Math.hypot(e[4], e[5]);
    if (ax < 0.5 || ny < 0.5) continue; // not upright
    out.push({
      model,
      origin: [e[12] + game.origin[0], e[13] + game.origin[1], e[14] + game.origin[2]],
      along: [e[0] / ax, e[1] / ax],
      normal: [e[4] / ny, e[5] / ny],
      start: box.min.x,
      end: box.max.x,
      top: box.max.z,
      electric: placement.electric ?? "",
    });
  }
  return out;
}
