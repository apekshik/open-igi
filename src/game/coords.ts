// Coordinate conventions.
//
// Game logic works in IGI world units: X east, Y north, Z up, 4096 units per metre, absolute coordinates as stored in
// the level files (values around 1e7..1e8). Rendering uses three.js (Y up). Game.world is a group that turns IGI
// space into three.js space and is offset by Game.origin so the GPU sees small numbers:
//   three (x, y, z) = (igi.x - origin.x, igi.z - origin.z, -(igi.y - origin.y))
// Objects added to Game.world take IGI-space positions relative to the origin: `game.local(p)`.

import * as THREE from "three";
export { METRE } from "../level/load.ts";

export type Vec3 = [number, number, number];

export const vec3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  length: (a: Vec3) => Math.hypot(a[0], a[1], a[2]),
  distance: (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  normalize: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** Unit vector for a heading and pitch. Yaw is about Z: 0 faces +Y (north), positive turns counter-clockwise. */
export function direction(yaw: number, pitch = 0): Vec3 {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.cos(yaw) * c, Math.sin(pitch)];
}

/** IGI-space vector → three.js-space vector (no origin offset; for directions). */
export function toThreeDir(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[2], -v[1]);
}
