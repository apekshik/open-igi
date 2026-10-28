// Load everything a mission level needs from the player's install, independent of how it is shown.
import { decodeQvm, type QvmCall } from "../formats/qvm.ts";
import { decodeTexArray, type Texture } from "../formats/tex.ts";
import { isCtr44, parseBit, parseCtr, parseHmp, parseLmp, terrainMaterials, type CtrNode } from "../formats/terrain.ts";
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
  const ctrBytes = await read("terrain.ctr");
  let ctr: CtrNode[];
  let cmd = await read("terrain.cmd");
  if (isCtr44(ctrBytes)) {
    // Level 14 (indoors apart from its intro): no terrain rather than one read at the wrong stride.
    console.warn(`${level}: terrain.ctr uses 44-byte records, which are not supported yet; the level has no terrain`);
    const empty = (): CtrNode => ({ children: new Int16Array(8), transforms: new Int8Array(8).fill(-1), childMask: 0, cmdOffset: 0 });
    ctr = [empty(), empty()];
    cmd = new Uint8Array(8);
  } else ctr = parseCtr(ctrBytes);
  const data: TerrainData = {
    ctr,
    cmd,
    patches: objects.heightMaps
      .filter((h) => hmp[h.id])
      .map((h) => ({ level: h.level, min: cubeMinAt(h.position, h.level), size: h.size, heights: hmp[h.id]! })),
    modifiers: objects.textureModifiers
      .filter((m) => bit[m.bitmap])
      .map((m) => ({ level: m.level, min: cubeMinAt(m.position, m.level), material: m.material, size: m.size, bits: bit[m.bitmap]!.bits })),
    lightMaps: objects.terrainLightMaps.map((l) => ({ level: l.level, min: cubeMinAt(l.position, l.level), size: l.size, index: l.index })),
    discards: objects.discardTerrain.map((d) => ({ level: d.level, min: cubeMinAt(d.position, d.level) })),
    materials: terrainMaterials(decodeQvm(await read("terrain.qvm"))),
  };
  return { data, textures: decodeTexArray(await read("terrain.tex")), lightMaps: parseLmp(await read("terrain.lmp")) };
}
