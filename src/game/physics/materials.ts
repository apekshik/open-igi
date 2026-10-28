// Surface materials from the game's own tables:
//   material/material.qvm: SetActiveMaterial(n); DefineQMaterial(transparency, ...); DefineGameMaterial(name,
//                          stopping, ?, ?, passThrough, ...footstep, landing and bullet-impact sounds, decals...)
//   terrain/terrain.qvm:   CreateTerrainMaterial(terrainMaterial, gameMaterial, ...per-level texture settings)
// Collision faces (CMAT) and terrain triangles both resolve to a game material id from material.qvm.

import { decodeQvm, type QvmValue } from "../../formats/qvm.ts";
import type { Vfs } from "../../vfs/vfs.ts";

export interface GameMaterial {
  id: number;
  /** "Ground", "Wood", "Concrete", "Glass", "HumanCollision", ... */
  name: string;
  /**
   * DefineQMaterial's first value: 1 for Air, Glass and the invisible collision materials, 0.8 for Fence, 0
   * otherwise. Read as how much the surface lets sight through.
   */
  transparency: number;
  /**
   * DefineGameMaterial's fifth value: TRUE for Air, Water, Carton, Snow and the invisible collision materials
   * (HumanCollision, MetalLadder, MetalFence). We treat it as "not a solid surface for bullets" on model faces.
   */
  passThrough: boolean;
  /**
   * DefineGameMaterial's first value, read as how well the surface stops bullets: 10 Ground/Gravel/StrongMetal,
   * 5 Concrete/NormalMetal, 3 SoftMetal, 1 Wood/Carton/Flesh/Plastic, 0 Fence/Glass/Textiles/Rug/Porcelain/Air/Water.
   */
  stopping: number;
}

/**
 * Do bullets fly through this surface? Rail and chain-link fences and glass do in IGI (Mission 4's sniping from the
 * water tower is through its railing): they stop nothing and are see-through. Opaque zero-stopping surfaces (rugs,
 * porcelain, textiles) still take the hit.
 */
export function bulletsPass(m: GameMaterial): boolean {
  return m.passThrough || (m.stopping <= 0 && m.transparency > 0.5);
}

/** Built-in fallback names (material.qvm order in the retail game) if the script is missing. */
const DEFAULT_NAMES = [
  "Air", "Ground", "Water", "Wood", "Carton", "StrongMetal", "NormalMetal", "SoftMetal", "Flesh", "BloodyFlesh",
  "Textiles", "Concrete", "Runway", "Rug", "Glass", "Plastic", "Porcelain", "Rubber", "Fence", "Gravel", "Snow",
  "HumanCollision", "MetalLadder", "MetalFence",
];

const isTrue = (v: QvmValue | undefined) => typeof v === "object" && "ident" in v && v.ident === "TRUE";
const num = (v: QvmValue | undefined) => (typeof v === "number" ? v : 0);

export async function loadGameMaterials(vfs: Vfs): Promise<GameMaterial[]> {
  const fallback = DEFAULT_NAMES.map((name, id) => ({ id, name, transparency: 0, passThrough: false, stopping: 10 }));
  if (!vfs.has("material/material.qvm")) return fallback;
  const out: GameMaterial[] = [];
  let active = 0;
  let transparency = 0;
  for (const call of decodeQvm(await vfs.read("material/material.qvm"))) {
    if (call.fn === "SetActiveMaterial") active = num(call.args[0]);
    else if (call.fn === "DefineQMaterial") transparency = num(call.args[0]);
    else if (call.fn === "DefineGameMaterial") {
      out[active] = { id: active, name: String(call.args[0]), transparency, passThrough: isTrue(call.args[4]), stopping: num(call.args[1]) };
      transparency = 0;
    }
  }
  return out.length ? out : fallback;
}

/** terrain.qvm: game material id for each terrain material index (1 = Ground, 20 = Snow in the retail levels). */
export async function loadTerrainGameMaterials(vfs: Vfs, level: string): Promise<number[]> {
  const path = `missions/location0/${level}/terrain/terrain.qvm`;
  if (!vfs.has(path)) return [];
  const out: number[] = [];
  for (const call of decodeQvm(await vfs.read(path))) {
    if (call.fn === "CreateTerrainMaterial") out[num(call.args[0])] = num(call.args[1]);
  }
  return out;
}

/**
 * magicobj/magicobj.qvm: `DefineMagicObj(model, model, TASKTYPE_*, ...)` gives models engine behaviour by type. Ladders
 * are TASKTYPE_LADDER models (e.g. 435_02_1, Mission 4's water-tower ladder, whose faces are tagged Fence); rotors,
 * wheels, glass and radar dishes are listed the same way. Returns model name → type ("LADDER", "ROTOR", ...).
 */
export async function loadMagicObjTypes(vfs: Vfs): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const path = "magicobj/magicobj.qvm";
  if (!vfs.has(path)) return out;
  for (const call of decodeQvm(await vfs.read(path))) {
    if (call.fn !== "DefineMagicObj") continue;
    const [model, , type] = call.args;
    const t = typeof type === "object" && "ident" in type ? type.ident : String(type);
    if (typeof model === "string") out.set(model, t.replace(/^TASKTYPE_/, ""));
  }
  return out;
}
