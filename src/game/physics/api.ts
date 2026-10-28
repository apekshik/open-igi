import type { Vec3 } from "../coords.ts";

export interface RayHit {
  point: Vec3;
  /** Surface normal (unit, IGI space). */
  normal: Vec3;
  distance: number;
  /** The entity hit, if the ray hit an entity's hit volume before any static geometry. */
  entityId: number | null;
  /** Body region for characters ("head", "torso", "legs"), or a surface material name for static geometry. */
  part?: string;
}

export interface RaycastOptions {
  /** Skip this entity (usually the shooter). */
  ignoreEntity?: number;
  /** Test entities as well as static geometry (default true). */
  entities?: boolean;
}

/** Collision and spatial queries. All coordinates are IGI world units. */
export interface PhysicsService {
  /** Highest walkable surface under (x, y) at or below `fromZ` (default: very high), or null if none. */
  groundHeight(x: number, y: number, fromZ?: number): number | null;
  /** First hit along the segment from → to, or null. */
  raycast(from: Vec3, to: Vec3, options?: RaycastOptions): RayHit | null;
  /** Can a point at `from` see `to` (no static geometry between)? */
  lineOfSight(from: Vec3, to: Vec3): boolean;
  /**
   * Move a vertical capsule (feet at `feet`) by `delta`, sliding along static geometry and stepping up small ledges.
   * Returns the new feet position and whether it ends standing on ground.
   */
  move(feet: Vec3, delta: Vec3, radius: number, height: number): { position: Vec3; grounded: boolean };
}
