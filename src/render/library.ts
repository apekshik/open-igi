// Model library: resolves a model name across one or more (models.res, textures.res, .mtp) sets and builds
// three.js meshes with their real textures. Geometry and materials are cached per model.
import * as THREE from "three";
import { readRes } from "../formats/ilff.ts";
import { decodeMef } from "../formats/mef.ts";
import { parseMtp, type MaterialTable } from "../formats/mtp.ts";
import { decodeTex } from "../formats/tex.ts";
import type { Vfs } from "../vfs/vfs.ts";

const NO_MATERIAL = 0xffff;

interface ModelSet {
  models: Map<string, Uint8Array>;
  textures: Map<string, Uint8Array>;
  mtp: MaterialTable;
  modelIndex: Map<string, number>;
}

export interface BuiltModel {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  type: number;
  /** "slot→texture" per batch, for display. */
  textureNames: string[];
}

const baseName = (path: string) => path.split("/").pop()!.replace(/\.\w+$/, "");

async function archive(vfs: Vfs, path: string) {
  return new Map(readRes(await vfs.read(path)).map((e) => [baseName(e.name), e.data]));
}

/** Archive sets for a mission level, most specific first. */
export async function levelLibrary(vfs: Vfs, level: string): Promise<ModelLibrary> {
  const sets: ModelSet[] = [];
  const add = async (dir: string, name: string) => {
    const mtp = parseMtp(await vfs.read(`${dir}/${name}.mtp`));
    sets.push({
      models: await archive(vfs, `${dir}/models/${name}.res`),
      textures: await archive(vfs, `${dir}/textures/${name}.res`),
      mtp,
      modelIndex: new Map(mtp.models.map((m, i) => [m, i])),
    });
  };
  await add(`missions/location0/${level}`, level);
  await add("missions/location0/common", "location0");
  return new ModelLibrary(sets);
}

export class ModelLibrary {
  private built = new Map<string, BuiltModel | null>();
  private textures = new Map<string, THREE.Texture | null>();
  wireframe = false;
  private sets: ModelSet[];

  constructor(sets: ModelSet[]) {
    this.sets = sets;
  }

  /** Model names of the first (level) set, in material-table order. */
  get levelModels(): string[] {
    return this.sets[0]?.mtp.models ?? [];
  }

  build(name: string): BuiltModel | null {
    if (this.built.has(name)) return this.built.get(name)!;
    let result: BuiltModel | null = null;
    for (const set of this.sets) {
      const bytes = set.models.get(name);
      const index = set.modelIndex.get(name);
      if (!bytes || index === undefined) continue;
      result = this.buildFrom(set, bytes, set.mtp.modelTextures[index] ?? []);
      break;
    }
    this.built.set(name, result);
    return result;
  }

  clear() {
    this.built.clear();
  }

  private buildFrom(set: ModelSet, bytes: Uint8Array, slots: number[]): BuiltModel {
    const model = decodeMef(bytes);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(model.normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(model.uvs, 2));
    const indices = new Uint32Array(model.batches.reduce((n, b) => n + b.indices.length, 0));
    const materials: THREE.Material[] = [];
    const textureNames: string[] = [];
    let at = 0;
    model.batches.forEach((b, i) => {
      indices.set(b.indices, at);
      geometry.addGroup(at, b.indices.length, i);
      at += b.indices.length;
      const texName = b.material === NO_MATERIAL ? undefined : set.mtp.textures[slots[b.material]];
      const map = texName ? this.texture(texName) : null;
      textureNames.push(`${b.material}→${texName ?? "-"}`);
      materials.push(
        new THREE.MeshLambertMaterial({
          map,
          color: map ? 0xffffff : 0x999999,
          side: THREE.DoubleSide,
          alphaTest: 0.5,
          wireframe: this.wireframe,
        }),
      );
    });
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    return { geometry, materials, type: model.type, textureNames };
  }

  private texture(name: string): THREE.Texture | null {
    if (this.textures.has(name)) return this.textures.get(name)!;
    let bytes: Uint8Array | undefined;
    for (const set of this.sets) {
      bytes = set.textures.get(name) ?? set.textures.get(`${name}_argb8888`);
      if (bytes) break;
    }
    let t: THREE.Texture | null = null;
    if (bytes) {
      const tex = decodeTex(bytes);
      t = new THREE.DataTexture(tex.rgba, tex.width, tex.height);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 8;
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
    }
    this.textures.set(name, t);
    return t;
  }
}
