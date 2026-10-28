// Load everything a mission level needs from the player's install, independent of how it is shown.
import { decodeQvm, type QvmCall } from "../formats/qvm.ts";
import { decodeTexArray, type Texture } from "../formats/tex.ts";
import { parseBit, parseCtr, parseHmp, parseLmp, terrainMaterials } from "../formats/terrain.ts";
import { levelLibrary, type ModelLibrary } from "../render/library.ts";
import type { Vfs } from "../vfs/vfs.ts";
import { levelObjects, type LevelObjects } from "./objects.ts";
import { cubeMinAt, type TerrainData } from "./terrain.ts";

/** IGI world units per metre (2^12; see THIRD_PARTY.md, flawme). */
export const METRE = 4096;

export interface TerrainInputs {
  data: TerrainData;
  textures: Texture[];
  lightMaps: { size: number; pixels: Uint8Array }[];
}

export interface LoadedLevel {
  /** "level1".."level14". */
  name: string;
  /** missions/location0/<name> */
  dir: string;
  library: ModelLibrary;
  /** The decoded objects.qvm statements (the full Task_New tree). */
  statements: QvmCall[];
  objects: LevelObjects;
  terrain: TerrainInputs;
}

export async function loadLevel(vfs: Vfs, name: string): Promise<LoadedLevel> {
  const dir = `missions/location0/${name}`;
  const statements = decodeQvm(await vfs.read(`${dir}/objects.qvm`));
  const objects = levelObjects(statements);
  const [library, terrain] = await Promise.all([levelLibrary(vfs, name), loadTerrainInputs(vfs, name, objects)]);
  return { name, dir, library, statements, objects, terrain };
}

export async function loadTerrainInputs(vfs: Vfs, level: string, objects: LevelObjects): Promise<TerrainInputs> {
  const dir = `missions/location0/${level}/terrain`;
  const read = (name: string) => vfs.read(`${dir}/${name}`);
  const hmp = vfs.has(`${dir}/terrain.hmp`) ? parseHmp(await read("terrain.hmp")) : [];
  const bit = parseBit(await read("terrain.bit"));
  const data: TerrainData = {
    ctr: parseCtr(await read("terrain.ctr")),
    cmd: await read("terrain.cmd"),
    patches: objects.heightMaps
      .filter((h) => hmp[h.id])
      .map((h) => ({ level: h.level, min: cubeMinAt(h.position, h.level), size: h.size, heights: hmp[h.id]! })),
    modifiers: objects.textureModifiers
      .filter((m) => bit[m.bitmap])
      .map((m) => ({ level: m.level, min: cubeMinAt(m.position, m.level), material: m.material, size: m.size, bits: bit[m.bitmap]!.bits })),
    lightMaps: objects.terrainLightMaps.map((l) => ({ level: l.level, min: cubeMinAt(l.position, l.level), size: l.size, index: l.index })),
    materials: terrainMaterials(decodeQvm(await read("terrain.qvm"))),
  };
  return { data, textures: decodeTexArray(await read("terrain.tex")), lightMaps: parseLmp(await read("terrain.lmp")) };
}
