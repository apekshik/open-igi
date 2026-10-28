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
   * is the locomotive's distance along its railroad in world units, `active` shows or hides it (the mission system
   * clears it while the train's ConditionalContainer is not running) and `throttle` is its thrust lever (0..1 of the
   * train's MaxSpeed).
   */
  train(taskId: number): { active: boolean; running: boolean; throttle: number; position: number; speed: number } | undefined;
  /**
   * Car `index` (0 = the locomotive) of a Train task: its pose now (null while the train is hidden or the car is off
   * the track) and where the level places it. Passengers and cutscene cameras placed with a train keep their offset
   * from its car.
   */
  trainCar?(taskId: number, index: number): { current: TrainCarPose | null; reference: TrainCarPose | null } | undefined;
  /** Put a train back where the level places it (its container starts again). */
  resetTrain?(taskId: number): void;
  /** Draw-call relevant counts of the static world renderer, for profiling. */
  stats(): Record<string, number>;
}

/** A train car's pose in absolute IGI units: its origin and model axes (x along the track, y left, z up). */
export interface TrainCarPose {
  origin: Vec3;
  axes: [Vec3, Vec3, Vec3];
}
