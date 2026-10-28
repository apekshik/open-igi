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
  /** Model name of the static object or dynamic collider hit (undefined for terrain and entities). */
  model?: string;
  /** Id of the dynamic collider hit (door, vehicle, train car), if any. */
  collider?: number;
  /** The model hit is a climbable ladder (TASKTYPE_LADDER in magicobj/magicobj.qvm). */
  ladder?: boolean;
}

export interface RaycastOptions {
  /** Skip this entity (usually the shooter). */
  ignoreEntity?: number;
  /** Test entities as well as static geometry (default true). */
  entities?: boolean;
  /**
   * A bullet: fly through surfaces that don't stop bullets in IGI (rail and chain-link fences, glass). Everything else
   * (grenades, ladder checks, cameras) leaves this off and treats them as solid.
   */
  bullet?: boolean;
}

export interface GroundHit {
  z: number;
  /** Upward unit normal. */
  normal: Vec3;
  material?: SurfaceMaterial;
  /**
   * Id of the dynamic collider stood on (elevator car, train roof, vehicle), if any. The physics system carries
   * characters standing on a moving collider along with it before they move each frame.
   */
  platform?: number;
}

/**
 * A moving collider: a model's .mef collision sets ("hit" for rays and sight, "human" hull for movement) at a pose
 * updated every frame. Raycasts, line of sight, ground and movement see it where it is now.
 */
export interface DynamicCollider {
  readonly id: number;
  readonly model: string;
  /**
   * Place the collider by a rigid column-major 4x4 in `game.world`'s frame (origin-relative, Z up), e.g. the
   * `matrix` of an Object3D that is a direct child of game.world.
   */
  setMatrix(matrix: ArrayLike<number>): void;
  /** Place the collider at an absolute position with Euler angles as stored in objects.qvm (three.js "ZYX" order). */
  setPose(position: Vec3, rotation: Vec3): void;
  /** Disabled colliders take part in no query (hidden, destroyed or despawned objects). */
  enabled: boolean;
  /**
   * Remove the static geometry this collider covers at `matrix` (default: where it is now): some buildings carry a
   * closed door leaf in their own collision where a Door object sits. Returns how many triangles were dropped.
   */
  carve(matrix?: ArrayLike<number>): number;
  /** Entity reported as hit by rays against this collider (doors, vehicles), or null. */
  entityId: number | null;
  remove(): void;
}

export interface MoveOptions {
  /** Highest ledge stepped onto without jumping (default 0.45 m). */
  stepHeight?: number;
  /** Steepest walkable slope, as the minimum normal z (default cos 50°). */
  walkableZ?: number;
  /** Collide with real shapes only, not the grown human hulls (ladder climbing: hulls close over ladders). */
  ignoreHulls?: boolean;
  /** The entity moving: while it rides a moving collider, that collider's hull is ignored (truck beds, lifts). */
  entityId?: number;
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
  /**
   * Register a moving collider for a model (by name, from the level's model archives), initially at `matrix`
   * (see DynamicCollider.setMatrix). Returns null if the model has no usable collision.
   */
  addDynamic?(model: string, matrix: ArrayLike<number>, options?: { entityId?: number }): DynamicCollider | null;
  /** Timing of the last frame's dynamic-collider work (carry and push), for profiling. */
  dynamicStats?(): { colliders: number; moved: number; carried: number; pushed: number; ms: number };
}
