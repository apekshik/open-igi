import type { Vec3 } from "../coords.ts";

/**
 * A game material name from material/material.qvm: "Ground", "Wood", "Concrete", "StrongMetal", "NormalMetal",
 * "SoftMetal", "Glass", "Fence", "Gravel", "Snow", "Water", "Carton", "Textiles", "Runway", "Rug", "Plastic",
 * "Porcelain", "Rubber", "Flesh", ... Footstep, landing and bullet-impact sounds are chosen by it.
 */
export type SurfaceMaterial = string;

export interface RayHit {
  point: Vec3;
  /** Surface normal (unit, IGI space), facing back along the ray. */
  normal: Vec3;
  distance: number;
  /** The entity hit, if the ray hit an entity's hit volume before any static geometry. */
  entityId: number | null;
  /** Body region for characters ("head", "torso", "legs"), or a surface material name for static geometry. */
  part?: string;
  /** Surface material of static geometry and terrain (undefined for entities and untagged faces). */
  material?: SurfaceMaterial;
  /** Model name of the static object hit (undefined for terrain and entities). */
  model?: string;
}

export interface RaycastOptions {
  /** Skip this entity (usually the shooter). */
  ignoreEntity?: number;
  /** Test entities as well as static geometry (default true). */
  entities?: boolean;
}

export interface GroundHit {
  z: number;
  /** Upward unit normal. */
  normal: Vec3;
  material?: SurfaceMaterial;
}

export interface MoveOptions {
  /** Highest ledge stepped onto without jumping (default 0.45 m). */
  stepHeight?: number;
  /** Steepest walkable slope, as the minimum normal z (default cos 50°). */
  walkableZ?: number;
}

export interface MoveResult {
  position: Vec3;
  grounded: boolean;
  /** What the feet stand on when grounded (for footsteps and slope handling). */
  ground?: GroundHit;
}

/** Collision and spatial queries. All coordinates are IGI world units. */
export interface PhysicsService {
  /** Highest walkable surface under (x, y) at or below `fromZ` (default: very high), or null if none. */
  groundHeight(x: number, y: number, fromZ?: number): number | null;
  /** Like groundHeight, with the surface normal and material. */
  ground?(x: number, y: number, fromZ?: number): GroundHit | null;
  /** First hit along the segment from → to, or null. */
  raycast(from: Vec3, to: Vec3, options?: RaycastOptions): RayHit | null;
  /** Can a point at `from` see `to` (no static geometry between)? Glass and chain-link fences do not block sight. */
  lineOfSight(from: Vec3, to: Vec3): boolean;
  /**
   * Move a vertical capsule (feet at `feet`) by `delta`, sliding along static geometry and stepping up small ledges.
   * Returns the new feet position and whether it ends standing on ground.
   */
  move(feet: Vec3, delta: Vec3, radius: number, height: number, options?: MoveOptions): MoveResult;
}
