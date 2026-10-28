import type { Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";

export type Stance = "stand" | "crouch" | "prone";

export interface PlayerService {
  readonly entity: Entity;
  /** Eye position (IGI units) and view angles (radians; pitch up positive). */
  eye(): Vec3;
  yaw: number;
  pitch: number;
  stance: Stance;
  /** Field of view in degrees (weapons/binoculars may change it for zoom). */
  fov: number;
  /** Disable movement and look (menus, map computer, cutscenes). */
  frozen: boolean;
}
