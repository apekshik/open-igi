import type { Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";

/** IGI 1 has standing and crouched only; "prone" is an open-igi addition (key Z). */
export type Stance = "stand" | "crouch" | "prone";

/** What the legs are doing, for weapons (sway, spread), HUD and AI. */
export type Gait = "idle" | "walk" | "run" | "crouch" | "crawl" | "air" | "ladder" | "dead";

export interface PlayerService {
  /**
   * Jones. `health`/`maxHealth` are in IGI damage units: the player dies after `maxHealth` (3.0 from humanplayer.qvm)
   * of damage, where a weapon's damage per hit is its Damage Factor (AK47 0.3) times the hit-zone multiplier.
   * Damage arrives as `damage` events targeting this entity; the player emits `death` once.
   */
  readonly entity: Entity;
  /** Eye position (IGI units) and view angles (radians; pitch up positive). The eye includes lean and bob. */
  eye(): Vec3;
  yaw: number;
  pitch: number;
  /** Current stance (the stance the body is in or blending into). */
  readonly stance: Stance;
  /** Field of view in degrees (vertical). Weapons/binoculars change it for zoom and set it back to `defaultFov`. */
  fov: number;
  readonly defaultFov: number;
  /** Disable movement and look (menus, map computer, cutscenes). The view is still drawn from the player. */
  frozen: boolean;
  /** Feet velocity in IGI units per second. */
  readonly velocity: Vec3;
  readonly grounded: boolean;
  readonly gait: Gait;
  /** Lean amount, -1 (full left) .. 1 (full right). */
  readonly lean: number;
  readonly dead: boolean;
  /** Debug third-person camera showing Jones's body (toggled with V). */
  thirdPerson: boolean;
  /** Restore health (medipacks), clamped to `maxHealth`. */
  heal(amount: number): void;
  /** Move Jones (feet position) and optionally turn him; clears velocity. */
  teleport(feet: Vec3, yaw?: number): void;
}
