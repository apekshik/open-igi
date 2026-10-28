// The level's climbable ladders, as frames the climb can be laid out in. Ladders are models typed TASKTYPE_LADDER in
// magicobj/magicobj.qvm (the physics service lists them); levels place them as attachments of the building or tower
// they lean on (Mission 4's water tower carries 435_02_1), occasionally as placements of their own.
//
// The ladder models share one layout (435_02_1, 400_17_1, 400_18_1, 402_02_1): two rails 0.54 m apart along model X,
// standing at model Y ≈ 0 from Z = 0 up, with an alpha-tested plane of rungs between them and the rails' tops hooked
// over towards -Y, onto the roof or deck the ladder leads to. So the climber stands on +Y and faces -Y. The rung plane
// repeats one 64x64 texture per rung: 23.976 repeats over 30081 units on 400_18_1, a rung every 1254.6 units
// (0.306 m), which is exactly half the 0.612 m that the climb clip (168) rises per cycle: one rung per hand-over-hand
// step. The rung sits in the texture's first 6 rows, which put the rungs 0.29 m + n x 0.306 m above the model origin.
import * as THREE from "three";
import type { Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";

/** Rung spacing of the shared ladder texture, model units (used when a model's UVs do not give one). */
export const RUNG_PITCH = 1254.6;
/** The texture row band (v) the rung occupies; its centre is the rung. */
const RUNG_V = 3 / 64;

export interface Ladder {
  model: string;
  /** World position (absolute IGI units) of the model origin: centre of the rails at their foot. */
  origin: Vec3;
  /** Horizontal unit vector the climber faces (model -Y: into the ladder, towards the wall and the hooks). */
  face: [number, number];
  /** Heading for `face` (coords.direction convention). */
  yaw: number;
  /** Half the rails' spacing (model X extent), units. */
  halfWidth: number;
  /** Model Z of the ladder's foot and of the top of its rungs, above the origin. */
  bottom: number;
  rungTop: number;
  /** Rung spacing and the height above the origin of a rung's centre, minus whole pitches (0..pitch). */
  pitch: number;
  rungPhase: number;
}

/** Find every ladder placed in the level (placements and their attachments, at any depth). */
export function findLadders(game: Game): Ladder[] {
  const models = game.services.physics?.ladders;
  if (!models?.size) return [];
  const out: Ladder[] = [];
  const shapes = new Map<string, Shape | null>();
  const shapeOf = (model: string) => {
    if (!shapes.has(model)) shapes.set(model, ladderShape(game, model));
    return shapes.get(model)!;
  };
  const m = new THREE.Matrix4();
  for (const object of game.staticObjects) {
    object.traverse((child) => {
      const model = (child.userData.attachment as string | undefined) ?? (child === object ? (child.userData.placement?.model as string | undefined) : undefined);
      if (!model || !models.has(model)) return;
      const shape = shapeOf(model);
      if (!shape) return;
      // Matrix in game.world's frame (origin-relative IGI space): the chain of local matrices up to the placement.
      m.identity();
      for (let n: THREE.Object3D | null = child; n && n !== object.parent; n = n.parent) {
        if (n.matrixAutoUpdate) n.updateMatrix();
        m.premultiply(n.matrix);
      }
      const e = m.elements;
      const fx = -e[4], fy = -e[5];
      const len = Math.hypot(fx, fy);
      if (len < 0.5) return; // a ladder lying down
      const face: [number, number] = [fx / len, fy / len];
      out.push({
        model,
        origin: [e[12] + game.origin[0], e[13] + game.origin[1], e[14] + game.origin[2]],
        face,
        yaw: Math.atan2(-face[0], face[1]),
        ...shape,
      });
    });
  }
  return out;
}

type Shape = Pick<Ladder, "halfWidth" | "bottom" | "rungTop" | "pitch" | "rungPhase">;

/** Rails' extent and the rung plane (the alpha-tested batch) of a ladder model. */
function ladderShape(game: Game, model: string): Shape | null {
  const built = game.level.library.build(model);
  if (!built) return null;
  const g = built.geometry;
  const pos = g.getAttribute("position");
  const uv = g.getAttribute("uv");
  if (!pos) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  const box = g.boundingBox!;
  const index = g.index;
  let rungTop = -Infinity;
  let pitch = RUNG_PITCH;
  let rungPhase = 1180.6;
  for (const group of g.groups) {
    const material = built.materials[group.materialIndex ?? 0];
    if (!material || !(material.alphaTest > 0)) continue;
    let lo = -1, hi = -1;
    for (let i = group.start; i < group.start + group.count; i++) {
      const v = index ? index.getX(i) : i;
      if (lo < 0 || pos.getZ(v) < pos.getZ(lo)) lo = v;
      if (hi < 0 || pos.getZ(v) > pos.getZ(hi)) hi = v;
    }
    if (lo < 0) continue;
    rungTop = Math.max(rungTop, pos.getZ(hi));
    const dz = pos.getZ(hi) - pos.getZ(lo);
    if (uv && dz > 0) {
      // v changes by one per rung up the plane; a rung's centre is where v = k + RUNG_V.
      const slope = (uv.getY(hi) - uv.getY(lo)) / dz;
      if (Math.abs(slope * dz) > 1) {
        pitch = 1 / Math.abs(slope);
        const vAtOrigin = uv.getY(lo) - pos.getZ(lo) * slope;
        rungPhase = mod((RUNG_V - vAtOrigin) / slope, pitch);
      }
    }
  }
  if (!Number.isFinite(rungTop)) rungTop = box.max.z - 0.6 * 4096;
  return { halfWidth: Math.max(-box.min.x, box.max.x), bottom: box.min.z, rungTop, pitch, rungPhase };
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
