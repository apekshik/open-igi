import type { Vec3 } from "../coords.ts";

/** Environment rendering: sky, lighting, fog and level-of-detail for the static world. */
export interface WorldService {
  /**
   * Fog in effect (world units, linear in distance from the eye) for systems that draw their own materials.
   * `color` is a raw (gamma-space) 0xRRGGBB value; with three.js materials use `new THREE.Color(color)`.
   */
  fog: { color: number; near: number; far: number };
  /** Sun light for the level's time of day: direction towards the sun (IGI space) and raw RGB colours (0..1). */
  sun: { direction: Vec3; front: [number, number, number]; back: [number, number, number] };
  /**
   * A Train task by id: `running` starts or stops it (trains whose AnimTask condition is "1" start running), `position`
   * is the locomotive's distance along its railroad in world units.
   */
  train(taskId: number): { running: boolean; position: number; speed: number } | undefined;
  /** Draw-call relevant counts of the static world renderer, for profiling. */
  stats(): Record<string, number>;
}
