// Turn a level's objects.qvm task tree into placed models.
//
// Every object is Task_New(id, type, name, ...params, ...children). Parameter layouts come from the script's own
// Task_DeclareParameters calls, or (for engine-defined types like EditRigidObj) from observation. See docs/FORMATS.md.

import type { QvmCall, QvmValue } from "../formats/qvm.ts";

export interface Placement {
  type: string;
  name: string;
  id: number;
  /** World position, IGI units (Z up, 4096 units per metre). */
  position: [number, number, number];
  /** Euler angles in radians, as stored (third is rotation about Z). */
  rotation: [number, number, number];
  model: string;
}

export interface HeightMapTask {
  position: [number, number, number];
  /** Octree level of the cube the patch covers. */
  level: number;
  size: number;
  /** Slot in terrain.hmp. */
  id: number;
}

export interface TextureModifierTask {
  position: [number, number, number];
  level: number;
  /** Terrain material painted where the bitmap is set. */
  material: number;
  /** Slot in terrain.bit. */
  bitmap: number;
  size: number;
}

export interface TerrainLightMapTask {
  position: [number, number, number];
  level: number;
  size: number;
  /** Index into terrain.lmp. */
  index: number;
}

/** DiscardTerrain: the terrain cube at `level` containing `position` (and its subtree) is not drawn or collided. */
export interface DiscardTerrainTask {
  position: [number, number, number];
  level: number;
}

export interface LevelObjects {
  placements: Placement[];
  heightMaps: HeightMapTask[];
  textureModifiers: TextureModifierTask[];
  terrainLightMaps: TerrainLightMapTask[];
  /** Holes cut in the terrain for tunnels and bunkers (level3, 5-9, 11-13). */
  discardTerrain: DiscardTerrainTask[];
  /** Position of the HumanPlayer task, if found. */
  playerStart: [number, number, number] | null;
  /** Count of every task type in the tree, for research. */
  typeCounts: Map<string, number>;
}

// Types whose params start (x, y, z, a, b, c, model).
const POSE_THEN_MODEL = new Set(["Building", "EditRigidObj"]);

export function levelObjects(statements: QvmCall[]): LevelObjects {
  const placements: Placement[] = [];
  const heightMaps: HeightMapTask[] = [];
  const textureModifiers: TextureModifierTask[] = [];
  const terrainLightMaps: TerrainLightMapTask[] = [];
  const discardTerrain: DiscardTerrainTask[] = [];
  const typeCounts = new Map<string, number>();
  let playerStart: [number, number, number] | null = null;

  const num = (v: QvmValue | undefined) => (typeof v === "number" ? v : NaN);

  function visit(task: QvmCall) {
    if (task.fn !== "Task_New") return;
    const [id, type, name, ...rest] = task.args;
    const t = String(type);
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    const p = rest.map(num);

    if (POSE_THEN_MODEL.has(t) && typeof rest[6] === "string") {
      placements.push({
        type: t,
        name: String(name),
        id: num(id),
        position: [p[0], p[1], p[2]],
        rotation: [p[3], p[4], p[5]],
        model: rest[6],
      });
    } else if (t === "Fence" && typeof rest[4] === "string") {
      // Fence: position, gamma angle, model.
      placements.push({ type: t, name: String(name), id: num(id), position: [p[0], p[1], p[2]], rotation: [0, 0, p[3]], model: rest[4] });
    } else if (t === "HeightMap") {
      // HeightMap: position, level, size, isEdit, bitmap id, normal smooth, blur smooth.
      heightMaps.push({ position: [p[0], p[1], p[2]], level: p[3], size: p[4], id: p[6] });
    } else if (t === "TextureModifier") {
      // TextureModifier: position, level, material index, bitmap id, size, isEdit.
      textureModifiers.push({ position: [p[0], p[1], p[2]], level: p[3], material: p[4], bitmap: p[5], size: p[6] });
    } else if (t === "TerrainLightMap") {
      // TerrainLightMap: position, level, size, texture index, generated when created.
      terrainLightMaps.push({ position: [p[0], p[1], p[2]], level: p[3], size: p[4], index: p[5] });
    } else if (t === "DiscardTerrain") {
      // DiscardTerrain: position, level.
      discardTerrain.push({ position: [p[0], p[1], p[2]], level: p[3] });
    } else if (t === "HumanPlayer" && playerStart === null) {
      // HumanPlayer: position, gamma, model, team. Mission 1 names it "TheGoodGuy".
      playerStart = [p[0], p[1], p[2]];
    }

    for (const child of rest) if (isCall(child)) visit(child);
  }

  for (const s of statements) visit(s);
  return { placements, heightMaps, textureModifiers, terrainLightMaps, discardTerrain, playerStart, typeCounts };
}

function isCall(v: QvmValue): v is QvmCall {
  return typeof v === "object" && "fn" in v;
}
