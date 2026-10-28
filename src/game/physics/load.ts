// Build the collision world for a loaded level: decode the collision sets of every placed model (from the same
// model archives the renderer uses), read the material tables, and hand everything to CollisionWorld.

import { decodeCollision, type ModelCollision } from "../../formats/collision.ts";
import { readRes } from "../../formats/ilff.ts";
import type { LoadedLevel } from "../../level/load.ts";
import type { Placement } from "../../level/objects.ts";
import type { Vfs } from "../../vfs/vfs.ts";
import { loadGameMaterials, loadTerrainGameMaterials } from "./materials.ts";
import { CollisionWorld, type StaticObjectInput } from "./world.ts";

export interface PlacedModel {
  placement: Placement;
  /** Column-major model → origin-relative matrix; computed from the placement when absent. */
  matrix?: ArrayLike<number>;
}

const baseName = (path: string) => path.split("/").pop()!.replace(/\.\w+$/, "");

/** Model bytes by name for a level: the level's own archive first, then the shared location0 archive. */
async function modelArchives(vfs: Vfs, level: string, wanted: Set<string>): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const path of [`missions/location0/${level}/models/${level}.res`, "missions/location0/common/models/location0.res"]) {
    if (!vfs.has(path)) continue;
    for (const e of readRes(await vfs.read(path))) {
      const name = baseName(e.name);
      if (wanted.has(name) && !out.has(name)) out.set(name, e.data);
    }
  }
  return out;
}

export async function buildCollisionWorld(vfs: Vfs, level: LoadedLevel, origin: [number, number, number], placed: PlacedModel[]): Promise<CollisionWorld> {
  const names = new Set(placed.map((p) => p.placement.model));
  const [bytes, materials, terrainGameMaterials] = await Promise.all([
    modelArchives(vfs, level.name, names),
    loadGameMaterials(vfs),
    loadTerrainGameMaterials(vfs, level.name),
  ]);
  const decoded = new Map<string, ModelCollision | null>();
  const collisionOf = (name: string) => {
    if (!decoded.has(name)) {
      const b = bytes.get(name);
      let c: ModelCollision | null = null;
      try {
        c = b ? decodeCollision(b) : null;
      } catch (e) {
        console.warn(`collision for ${name}: ${(e as Error).message}`);
      }
      decoded.set(name, c);
    }
    return decoded.get(name)!;
  };
  const objects: StaticObjectInput[] = [];
  for (const p of placed) {
    const collision = collisionOf(p.placement.model);
    if (!collision || (!collision.hit && !collision.human)) continue;
    objects.push({ model: p.placement.model, collision, matrix: p.matrix ?? placementMatrix(p.placement, origin), gates: p.placement.gates });
  }
  return new CollisionWorld({ origin, terrain: level.terrain.data, terrainGameMaterials, materials, objects });
}

/**
 * The matrix Game gives a placed model: translation to the origin-relative position, then the stored Euler angles
 * applied in three.js "ZYX" order (R = Rz(c) * Ry(b) * Rx(a)). Column-major.
 */
export function placementMatrix(p: Placement, origin: readonly number[]): number[] {
  const [a, b, c] = p.rotation;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  // Rows of Rz * Ry * Rx.
  const m00 = cc * cb, m01 = cc * sb * sa - sc * ca, m02 = cc * sb * ca + sc * sa;
  const m10 = sc * cb, m11 = sc * sb * sa + cc * ca, m12 = sc * sb * ca - cc * sa;
  const m20 = -sb, m21 = cb * sa, m22 = cb * ca;
  return [
    m00, m10, m20, 0,
    m01, m11, m21, 0,
    m02, m12, m22, 0,
    p.position[0] - origin[0], p.position[1] - origin[1], p.position[2] - origin[2], 1,
  ];
}
