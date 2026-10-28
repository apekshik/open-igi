// Stationary guns: StationaryGun tasks in objects.qvm, a heavy machine gun (WEAPON_ID_M2HB, model 123_01_1) on a
// mount (the task's holder model, 123_02_1) that sits on a sandbag wall, roof edge or tank tower. Nobody uses them
// but AITYPE_GUNNER soldiers: their level script names one with AIFunction_SetGunnerID(task), and gunner.qvm answers
// COMBAT and ALARMON with AIAction_Activate(gun) while AIFunction_GetGunnerStatus() is false (not at the gun yet),
// then AIAction_Combat ("Gunner Combat - Stand" in IGI.exe). The gun turns within the task's limits (max up/down
// angle, max sideways angle either side of its rest heading) and fires the weapon's own ballistics.
import * as THREE from "three";
import { direction, METRE, type Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";
import type { StationaryGunSpec } from "./level.ts";

/** Pivot above the task position (top of the 123_02_1 mount), barrel length of the 123_01_1 model. */
const PIVOT_HEIGHT = 0.15 * METRE;
const BARREL = 1.24 * METRE;
/** How far behind the pivot the gunner stands, and how fast the gun traverses (radians per second). */
const GUNNER_BEHIND = 0.95 * METRE;
const TRAVERSE = 1.6;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class MountedGun {
  readonly spec: StationaryGunSpec;
  readonly object = new THREE.Group();
  /** Current aim relative to the world (yaw about Z, pitch up positive). */
  yaw: number;
  pitch = 0;
  /** Entity id of the soldier manning it, or -1. */
  gunner = -1;
  ammo: number;
  private barrel = new THREE.Group();

  constructor(game: Game, spec: StationaryGunSpec, gunModel: string) {
    this.spec = spec;
    this.yaw = spec.yaw;
    this.ammo = spec.ammo;
    const lib = game.level.library;
    const mesh = (name: string) => {
      const b = name ? lib.build(name) : null;
      return b ? new THREE.Mesh(b.geometry, b.materials) : null;
    };
    const holder = mesh(spec.holderModel);
    if (holder) this.object.add(holder);
    const gun = mesh(gunModel);
    if (gun) this.barrel.add(gun);
    this.barrel.position.set(0, 0, PIVOT_HEIGHT);
    this.object.add(this.barrel);
    this.object.position.copy(game.local(spec.position));
    this.sync();
  }

  get pivot(): Vec3 {
    const p = this.spec.position;
    return [p[0], p[1], p[2] + PIVOT_HEIGHT];
  }

  /** Feet position for the gunner: behind the gun at its rest heading, on the floor below. */
  standPosition(game: Game): Vec3 {
    const back = direction(this.spec.yaw);
    const p = this.spec.position;
    const x = p[0] - back[0] * GUNNER_BEHIND, y = p[1] - back[1] * GUNNER_BEHIND;
    const z = game.services.physics?.groundHeight(x, y, p[2] + 0.5 * METRE) ?? p[2] - 1.3 * METRE;
    return [x, y, z];
  }

  /** Can the gun point at this position at all (within its traverse limits)? */
  covers(target: Vec3): boolean {
    const { yaw, pitch } = this.angles(target);
    return this.withinYaw(yaw) && pitch <= this.limit(this.spec.maxUp) && pitch >= -this.limit(-this.spec.maxDown);
  }

  /** Traverse towards a position; true when the barrel points at it. */
  aim(target: Vec3, dt: number): boolean {
    const want = this.angles(target);
    const side = (this.spec.maxSide * Math.PI) / 180;
    let rel = wrap(want.yaw - this.spec.yaw);
    if (side < Math.PI) rel = Math.max(-side, Math.min(side, rel));
    const wantYaw = this.spec.yaw + rel;
    const wantPitch = Math.max(-this.limit(-this.spec.maxDown), Math.min(this.limit(this.spec.maxUp), want.pitch));
    const dy = wrap(wantYaw - this.yaw), dp = wantPitch - this.pitch;
    const step = TRAVERSE * dt;
    this.yaw = Math.abs(dy) <= step ? wantYaw : wrap(this.yaw + Math.sign(dy) * step);
    this.pitch = Math.abs(dp) <= step ? wantPitch : this.pitch + Math.sign(dp) * step;
    this.sync();
    return Math.abs(wrap(want.yaw - this.yaw)) < 0.03 && Math.abs(want.pitch - this.pitch) < 0.03;
  }

  /** Unit vector along the barrel. */
  forward(): Vec3 {
    const c = Math.cos(this.pitch);
    const d = direction(this.yaw);
    return [d[0] * c, d[1] * c, Math.sin(this.pitch)];
  }

  muzzle(): Vec3 {
    const f = this.forward(), p = this.pivot;
    return [p[0] + f[0] * BARREL, p[1] + f[1] * BARREL, p[2] + f[2] * BARREL];
  }

  private angles(target: Vec3) {
    const p = this.pivot;
    const dx = target[0] - p[0], dy = target[1] - p[1], dz = target[2] - p[2];
    return { yaw: Math.atan2(-dx, dy), pitch: Math.atan2(dz, Math.hypot(dx, dy)) };
  }

  private withinYaw(yaw: number) {
    return this.spec.maxSide >= 180 || Math.abs(wrap(yaw - this.spec.yaw)) <= (this.spec.maxSide * Math.PI) / 180 + 0.02;
  }

  /** A limit in radians (0 in the data means the gun does not tilt that way; allow a few degrees of play). */
  private limit(deg: number) {
    return (Math.max(deg, 3) * Math.PI) / 180;
  }

  private sync() {
    this.object.rotation.set(0, 0, this.spec.yaw);
    this.barrel.rotation.set(this.pitch, 0, wrap(this.yaw - this.spec.yaw), "ZXY");
  }
}
