// Static world rendering: buildings with their baked lightmaps, and everything else lit by the sun.
//
// IGI lights static geometry two ways. Objects under a LightmapInfo task (buildings, their attached rooms and
// furniture) carry a per-object colour lightmap (.olm) that the renderer multiplies with the texture. Everything else
// (trees, fences, props) is lit by the directional sun: "Back Color" everywhere plus "Front Color" on faces turned to the
// sun. Both work on raw texel values, like the terrain renderer.
//
// To keep draw calls down:
//  - model textures are copied into a few texture arrays (one per size class), so batches that differ only in texture
//    draw together, picking their layer per vertex;
//  - each lightmapped building (a "cluster": its model, attachments and child objects) is merged into one mesh per
//    level of detail, with its lightmaps packed into one atlas: a handful of draws per building;
//  - every other model is drawn with one InstancedMesh per level of detail, its instances re-bucketed by distance.
import * as THREE from "three";
import type { ObjectLightMap } from "../formats/olm.ts";
import { textureAlpha, type ModelLibrary, type TextureAlpha } from "./library.ts";

/** Level of detail for one model: the LOD model names (most detailed first) and when to switch. */
export interface LodChain {
  names: string[];
  /** Distance (world units) at which each LOD after the first takes over; length names.length - 1. */
  switches: number[];
  /** Not drawn beyond this distance. */
  cutoff: number;
}

export interface ClusterPart {
  /** Most detailed model name ("400_20_1"). */
  model: string;
  /** Transform in IGI space, relative to the game origin. */
  matrix: THREE.Matrix4;
  /** Lightmap per LOD (same order as the part's LodChain.names), null where none was found. */
  lightMaps: (ObjectLightMap | null)[];
}

/** Uniforms every static material shares; change their values to relight the world. */
export function createStaticUniforms() {
  return {
    fogColor: { value: new THREE.Vector3(0.6, 0.6, 0.6) },
    fogNear: { value: 1e6 },
    fogFar: { value: 1e7 },
    /** Towards the sun, three.js world space. */
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunFront: { value: new THREE.Vector3(1, 1, 1) },
    sunBack: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
    /** Lightmap multiplier (the original's texture stage modulate). */
    lightScale: { value: 1 },
  };
}
export type StaticUniforms = ReturnType<typeof createStaticUniforms>;

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  in float layer;
  #ifdef USE_LIGHT_ATLAS
    in vec2 lmUv;
    out vec2 vLmUv;
  #endif
  out vec3 vUv;
  out vec3 vNormal;
  out float vFogDepth;
  void main() {
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
      m = m * instanceMatrix;
    #endif
    vUv = vec3(uv, layer);
    #ifdef USE_LIGHT_ATLAS
      vLmUv = lmUv;
    #endif
    vNormal = normalize(mat3(m) * normal);
    vec4 mvPosition = viewMatrix * m * vec4(position, 1.0);
    vFogDepth = length(mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  precision highp sampler2DArray;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2DArray maps;
  uniform float alphaTest;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  uniform vec3 sunDir;
  uniform vec3 sunFront;
  uniform vec3 sunBack;
  uniform float lightScale;
  #ifdef USE_LIGHT_ATLAS
    uniform sampler2D lightAtlas;
    in vec2 vLmUv;
  #endif
  in vec3 vUv;
  in vec3 vNormal;
  in float vFogDepth;
  out vec4 outColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 tex = texture(maps, vUv);
    #ifdef ALPHA_TO_COVERAGE
      // Sharpen the cut-out edge to about a pixel so MSAA coverage keeps thin wires and fences solid at range.
      tex.a = clamp((tex.a - 0.5) / max(fwidth(tex.a), 1e-4) + 0.5, 0.0, 1.0);
      if (tex.a <= 0.0) discard;
    #else
      if (tex.a < alphaTest) discard;
    #endif
    #ifdef USE_LIGHT_ATLAS
      vec3 light = texture(lightAtlas, vLmUv).rgb * lightScale;
    #else
      vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
      vec3 light = sunBack + sunFront * max(dot(n, sunDir), 0.0);
    #endif
    float fog = clamp((vFogDepth - fogNear) / (fogFar - fogNear), 0.0, 1.0);
    outColor = vec4(mix(tex.rgb * light, fogColor, fog), tex.a);
  }
`;

/** Texture size classes: every texture is resampled to the smallest class square that holds it. */
const CLASSES = [32, 64, 128, 256];
const classOf = (w: number, h: number) => CLASSES.find((c) => c >= Math.max(w, h)) ?? CLASSES[CLASSES.length - 1];

interface ArraySlot {
  size: number;
  layer: number;
  alpha: TextureAlpha;
}

/** Model textures copied into one texture array per size class (raw, gamma-space texels). */
class TextureArrays {
  private slots = new Map<THREE.Texture | null, ArraySlot>();
  private pending = new Map<number, (THREE.Texture | null)[]>();
  readonly arrays = new Map<number, THREE.DataArrayTexture>();

  add(t: THREE.Texture | null) {
    if (this.slots.has(t)) return;
    const size = t ? classOf(t.image.width, t.image.height) : CLASSES[0];
    const list = this.pending.get(size) ?? [];
    this.slots.set(t, { size, layer: list.length, alpha: textureAlpha(t) });
    list.push(t);
    this.pending.set(size, list);
  }

  slot(t: THREE.Texture | null): ArraySlot {
    const s = this.slots.get(t);
    if (!s) throw new Error("texture was not added before build()");
    return s;
  }

  /** Create the arrays; call once after every texture is added. Later additions are not supported. */
  build() {
    for (const [size, list] of this.pending) {
      const data = new Uint8Array(size * size * 4 * list.length);
      list.forEach((t, i) => data.set(t ? resample(t.image.data as Uint8Array, t.image.width, t.image.height, size) : grey(size), i * size * size * 4));
      const array = new THREE.DataArrayTexture(data, size, size, list.length);
      array.wrapS = array.wrapT = THREE.RepeatWrapping;
      array.magFilter = THREE.LinearFilter;
      array.minFilter = THREE.LinearMipmapLinearFilter;
      array.generateMipmaps = true;
      array.anisotropy = 8;
      array.needsUpdate = true;
      this.arrays.set(size, array);
    }
    this.pending.clear();
  }
}

/** Bilinear resample of a wrapping texture to size x size. */
function resample(src: Uint8Array, w: number, h: number, size: number): Uint8Array {
  if (w === size && h === size) return src;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const fy = ((y + 0.5) * h) / size - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const r0 = ((y0 % h) + h) % h;
    const r1 = (r0 + 1) % h;
    for (let x = 0; x < size; x++) {
      const fx = ((x + 0.5) * w) / size - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const c0 = ((x0 % w) + w) % w;
      const c1 = (c0 + 1) % w;
      for (let k = 0; k < 4; k++) {
        const a = src[(r0 * w + c0) * 4 + k] * (1 - tx) + src[(r0 * w + c1) * 4 + k] * tx;
        const b = src[(r1 * w + c0) * 4 + k] * (1 - tx) + src[(r1 * w + c1) * 4 + k] * tx;
        out[(y * size + x) * 4 + k] = Math.round(a + (b - a) * ty);
      }
    }
  }
  return out;
}

const grey = (size: number) => new Uint8Array(size * size * 4).fill(153).map((v, i) => (i % 4 === 3 ? 255 : v));

/** Shared materials for static models, one per (texture array, alpha mode, lightmap atlas). */
export class StaticMaterials {
  private cache = new Map<string, THREE.ShaderMaterial>();
  readonly uniforms: StaticUniforms;

  constructor(uniforms: StaticUniforms) {
    this.uniforms = uniforms;
  }

  get(maps: THREE.DataArrayTexture, alpha: TextureAlpha, atlas: THREE.Texture | null = null): THREE.ShaderMaterial {
    const key = `${maps.uuid}/${alpha}/${atlas?.uuid ?? "-"}`;
    let m = this.cache.get(key);
    if (m) return m;
    const defines: Record<string, string> = {};
    if (atlas) defines.USE_LIGHT_ATLAS = "";
    if (alpha === "mask") defines.ALPHA_TO_COVERAGE = "";
    m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      defines,
      uniforms: {
        ...this.uniforms,
        maps: { value: maps },
        lightAtlas: { value: atlas },
        alphaTest: { value: alpha === "blend" ? 0.02 : 0.5 },
      },
      side: THREE.DoubleSide,
      transparent: alpha === "blend",
      depthWrite: alpha !== "blend",
      alphaToCoverage: alpha === "mask",
    });
    this.cache.set(key, m);
    return m;
  }
}

interface Cluster {
  center: THREE.Vector3;
  radius: number;
  parts: { part: ClusterPart; chain: LodChain }[];
  chain: LodChain;
  atlas: THREE.DataTexture | null;
  /** Atlas rectangle per part and LOD, in atlas pixels (inside a 1-texel border). */
  rects: ({ x: number; y: number; w: number; h: number } | null)[][];
  atlasSize: [number, number];
  meshes: (THREE.Mesh | null | undefined)[];
  lod: number;
}

interface InstancedModel {
  chain: LodChain;
  /** Instance transforms and their centres (IGI local). */
  matrices: THREE.Matrix4[];
  centers: THREE.Vector3[];
  meshes: (THREE.InstancedMesh | null)[];
}

/** Vertex streams being merged into one mesh, one draw group per material. */
class MeshBuilder {
  private buckets = new Map<THREE.ShaderMaterial, { positions: number[]; normals: number[]; uvs: number[]; layers: number[]; lmUvs: number[]; indices: number[] }>();

  bucket(material: THREE.ShaderMaterial) {
    let b = this.buckets.get(material);
    if (!b) this.buckets.set(material, (b = { positions: [], normals: [], uvs: [], layers: [], lmUvs: [], indices: [] }));
    return b;
  }

  finish(withLightMap: boolean): { geometry: THREE.BufferGeometry; materials: THREE.ShaderMaterial[] } | null {
    if (!this.buckets.size) return null;
    // Opaque first, blended last, so a merged mesh draws its own blended parts over its solid ones.
    const all = [...this.buckets].sort((a, b) => Number(a[0].transparent) - Number(b[0].transparent));
    const vertexCount = all.reduce((s, [, b]) => s + b.layers.length, 0);
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const layers = new Float32Array(vertexCount);
    const lm = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(all.reduce((s, [, b]) => s + b.indices.length, 0));
    const geometry = new THREE.BufferGeometry();
    let vAt = 0;
    let iAt = 0;
    all.forEach(([, b], i) => {
      positions.set(b.positions, vAt * 3);
      normals.set(b.normals, vAt * 3);
      uvs.set(b.uvs, vAt * 2);
      layers.set(b.layers, vAt);
      if (withLightMap) lm.set(b.lmUvs, vAt * 2);
      for (let k = 0; k < b.indices.length; k++) indices[iAt + k] = b.indices[k] + vAt;
      geometry.addGroup(iAt, b.indices.length, i);
      vAt += b.layers.length;
      iAt += b.indices.length;
    });
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute("layer", new THREE.BufferAttribute(layers, 1));
    if (withLightMap) geometry.setAttribute("lmUv", new THREE.BufferAttribute(lm, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    return { geometry, materials: all.map(([m]) => m) };
  }
}

export class StaticRenderer {
  /** Add to Game.world (IGI space). */
  readonly group = new THREE.Group();
  private library: ModelLibrary;
  private materials: StaticMaterials;
  private textures = new TextureArrays();
  private clusters: Cluster[] = [];
  private instanced = new Map<string, InstancedModel>();
  private lastEye: THREE.Vector3 | null = null;
  /** Merged cluster meshes still to build; at most one per frame. */
  private pending: { cluster: Cluster; lod: number }[] = [];
  private deformed: { name: string; transform: VertexTransform }[] = [];
  private models = new Map<string, { geometry: THREE.BufferGeometry; materials: THREE.ShaderMaterial[] } | null>();

  constructor(library: ModelLibrary, materials: StaticMaterials) {
    this.library = library;
    this.materials = materials;
    this.group.matrixAutoUpdate = false;
  }

  /** A lightmapped building and everything lit with it, merged into one mesh per LOD. The first part decides LOD. */
  addCluster(parts: { part: ClusterPart; chain: LodChain }[]) {
    const box = new THREE.Box3();
    for (const { part, chain } of parts) {
      const g = this.library.build(chain.names[0])?.geometry;
      if (!g) continue;
      g.computeBoundingBox();
      box.union(g.boundingBox!.clone().applyMatrix4(part.matrix));
      for (const name of chain.names) this.addTextures(name);
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const cluster: Cluster = { center, radius, parts, chain: parts[0].chain, atlas: null, rects: [], atlasSize: [1, 1], meshes: [], lod: -1 };
    this.packAtlas(cluster);
    this.clusters.push(cluster);
  }

  /** An object drawn with its model's shared, instanced geometry, lit by the sun. */
  addInstance(chain: LodChain, matrix: THREE.Matrix4) {
    const key = chain.names[0];
    let group = this.instanced.get(key);
    if (!group) {
      this.instanced.set(key, (group = { chain, matrices: [], centers: [], meshes: [] }));
      for (const name of chain.names) this.addTextures(name);
    }
    group.matrices.push(matrix);
    const sphere = this.library.build(key)?.geometry.boundingSphere;
    group.centers.push((sphere?.center.clone() ?? new THREE.Vector3()).applyMatrix4(matrix));
  }

  /**
   * A model bent into place vertex by vertex (spline segments: rails, tunnels, wires), lit by the sun. All of them are
   * merged into one mesh in finish().
   */
  addDeformed(name: string, transform: VertexTransform) {
    if (!this.library.build(name)) return;
    this.addTextures(name);
    this.deformed.push({ name, transform });
  }

  /** Make a model available to createMesh() later (moving objects); call before finish(). */
  reserve(name: string) {
    this.addTextures(name);
  }

  /** A sun-lit mesh of a reserved model, for objects that move (trains). Geometry is shared per model. */
  createMesh(name: string): THREE.Mesh | null {
    const merged = this.modelMesh(name);
    return merged && new THREE.Mesh(merged.geometry, merged.materials);
  }

  /** Build texture arrays and meshes once every cluster and instance is added. */
  finish() {
    this.textures.build();
    for (const c of this.clusters) c.meshes[0] = this.buildCluster(c, 0);
    if (this.deformed.length) {
      const builder = new MeshBuilder();
      for (const d of this.deformed) this.appendModel(builder, d.name, d.transform, null, null);
      const merged = builder.finish(false);
      if (merged) this.group.add(new THREE.Mesh(merged.geometry, merged.materials));
      this.deformed = [];
    }
    for (const group of this.instanced.values()) {
      group.chain.names.forEach((name, lod) => {
        const merged = this.modelMesh(name);
        if (!merged) return void (group.meshes[lod] = null);
        const mesh = new THREE.InstancedMesh(merged.geometry, merged.materials, group.matrices.length);
        mesh.count = 0;
        mesh.visible = false;
        mesh.userData.staticModel = name;
        this.group.add(mesh);
        group.meshes[lod] = mesh;
      });
    }
  }

  /** Pick levels of detail for the eye position (IGI space, origin-relative). */
  update(eye: THREE.Vector3) {
    const job = this.pending.shift();
    if (job && !job.cluster.meshes[job.lod]) {
      job.cluster.meshes[job.lod] = this.buildCluster(job.cluster, job.lod);
      job.cluster.lod = -2;
    }
    // LOD distances are tens of metres and more; re-evaluate after moving a quarter metre.
    if (this.lastEye && this.lastEye.distanceToSquared(eye) < 1024 * 1024 && !job) return;
    this.lastEye = eye.clone();

    for (const c of this.clusters) {
      const d = Math.max(0, c.center.distanceTo(eye) - c.radius);
      let lod = pickLod(c.chain, d);
      if (lod > 0 && !c.meshes[lod]) {
        if (c.meshes[lod] === undefined) {
          c.meshes[lod] = null;
          this.pending.push({ cluster: c, lod });
        }
        // Until it is built, keep the nearest built level.
        while (lod > 0 && !c.meshes[lod]) lod--;
      }
      if (lod === c.lod) continue;
      c.lod = lod;
      c.meshes.forEach((m, i) => m && (m.visible = i === lod));
    }

    for (const group of this.instanced.values()) {
      const buckets: number[][] = group.meshes.map(() => []);
      group.centers.forEach((p, i) => {
        let lod = pickLod(group.chain, p.distanceTo(eye));
        if (lod < 0) return;
        while (lod > 0 && !group.meshes[lod]) lod--;
        buckets[lod]?.push(i);
      });
      group.meshes.forEach((mesh, lod) => {
        if (!mesh) return;
        const list = buckets[lod];
        mesh.count = list.length;
        mesh.visible = list.length > 0;
        list.forEach((i, k) => mesh.setMatrixAt(k, group.matrices[i]));
        mesh.instanceMatrix.needsUpdate = true;
        if (list.length) mesh.computeBoundingSphere();
      });
    }
  }

  private addTextures(name: string) {
    const built = this.library.build(name);
    for (const m of built?.materials ?? []) this.textures.add((m as THREE.MeshLambertMaterial).map);
  }

  /** Material and array layer for one batch of a built model. */
  private batchMaterial(map: THREE.Texture | null, atlas: THREE.Texture | null) {
    const slot = this.textures.slot(map);
    return { material: this.materials.get(this.textures.arrays.get(slot.size)!, slot.alpha, atlas), layer: slot.layer };
  }

  /** One model regrouped by array material, for instancing. */
  private modelMesh(name: string) {
    if (this.models.has(name)) return this.models.get(name)!;
    let merged = null;
    if (this.library.build(name)) {
      const builder = new MeshBuilder();
      this.appendModel(builder, name, null, null, null);
      merged = builder.finish(false);
    }
    this.models.set(name, merged);
    return merged;
  }

  /** Copy a model's batches into `builder`, moved by `transform`, with lightmap UVs mapped into the atlas rectangle. */
  private appendModel(
    builder: MeshBuilder,
    name: string,
    transform: VertexTransform | null,
    atlas: { texture: THREE.Texture; rect: { x: number; y: number; w: number; h: number }; size: [number, number] } | null,
    lmUvs: Float32Array | null,
  ) {
    const built = this.library.build(name)!;
    const g = built.geometry;
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    const uv = g.getAttribute("uv");
    const index = g.getIndex()!;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const group of g.groups) {
      const map = (built.materials[group.materialIndex!] as THREE.MeshLambertMaterial).map;
      const { material, layer } = this.batchMaterial(map, atlas && lmUvs ? atlas.texture : null);
      const b = builder.bucket(material);
      const remap = new Map<number, number>();
      for (let k = group.start; k < group.start + group.count; k++) {
        const v = index.getX(k);
        let out = remap.get(v);
        if (out === undefined) {
          out = b.layers.length;
          remap.set(v, out);
          p.fromBufferAttribute(pos, v);
          n.fromBufferAttribute(nor, v);
          transform?.(p, n);
          b.positions.push(p.x, p.y, p.z);
          b.normals.push(n.x, n.y, n.z);
          b.uvs.push(uv.getX(v), uv.getY(v));
          b.layers.push(layer);
          if (atlas && lmUvs) {
            const { rect, size } = atlas;
            b.lmUvs.push((rect.x + lmUvs[v * 2] * rect.w) / size[0], (rect.y + lmUvs[v * 2 + 1] * rect.h) / size[1]);
          } else {
            b.lmUvs.push(0, 0);
          }
        }
        b.indices.push(out);
      }
    }
  }

  /** Shelf-pack every lightmap of every part and LOD into one texture, each with a 1-texel border. */
  private packAtlas(c: Cluster) {
    const items: { part: number; lod: number; map: ObjectLightMap }[] = [];
    c.parts.forEach(({ part }, i) => {
      c.rects[i] = [];
      part.lightMaps.forEach((map, lod) => map && items.push({ part: i, lod, map }));
    });
    if (!items.length) return;
    const area = items.reduce((n, it) => n + (it.map.width + 2) * (it.map.height + 2), 0);
    const widest = Math.max(...items.map((it) => it.map.width + 2));
    const width = Math.max(THREE.MathUtils.ceilPowerOfTwo(widest), THREE.MathUtils.ceilPowerOfTwo(Math.ceil(Math.sqrt(area))));
    items.sort((a, b) => b.map.height - a.map.height);
    let x = 0;
    let y = 0;
    let shelf = 0;
    for (const it of items) {
      const w = it.map.width + 2;
      const h = it.map.height + 2;
      if (x + w > width) {
        x = 0;
        y += shelf;
        shelf = 0;
      }
      c.rects[it.part][it.lod] = { x: x + 1, y: y + 1, w: it.map.width, h: it.map.height };
      x += w;
      shelf = Math.max(shelf, h);
    }
    const height = THREE.MathUtils.ceilPowerOfTwo(y + shelf);
    const data = new Uint8Array(width * height * 4);
    for (const it of items) {
      const r = c.rects[it.part][it.lod]!;
      const { width: w, height: h, rgba } = it.map;
      // Copy with the border texels repeating the image's edge.
      for (let row = -1; row <= h; row++) {
        const sy = Math.min(h - 1, Math.max(0, row));
        for (let col = -1; col <= w; col++) {
          const sx = Math.min(w - 1, Math.max(0, col));
          data.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), ((r.y + row) * width + r.x + col) * 4);
        }
      }
    }
    const atlas = new THREE.DataTexture(data, width, height);
    atlas.magFilter = THREE.LinearFilter;
    atlas.minFilter = THREE.LinearFilter;
    atlas.needsUpdate = true;
    c.atlas = atlas;
    c.atlasSize = [width, height];
  }

  /** Merge every part at one LOD, positions relative to the cluster centre. */
  private buildCluster(c: Cluster, lod: number): THREE.Mesh | null {
    const builder = new MeshBuilder();
    const local = new THREE.Matrix4();
    c.parts.forEach(({ part, chain }, partIndex) => {
      const level = Math.min(lod, chain.names.length - 1);
      const name = chain.names[level];
      if (!this.library.build(name)) return;
      const rect = c.rects[partIndex]?.[level] ?? null;
      const lmUvs = rect ? (this.library.lighting(name)?.lightMapUvs ?? null) : null;
      local.makeTranslation(-c.center.x, -c.center.y, -c.center.z).multiply(part.matrix);
      this.appendModel(builder, name, matrixTransform(local), rect && c.atlas ? { texture: c.atlas, rect, size: c.atlasSize } : null, lmUvs);
    });
    const merged = builder.finish(true);
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged.geometry, merged.materials);
    mesh.position.copy(c.center);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  /** Object counts, for profiling. */
  stats() {
    let instancedMeshes = 0;
    let instances = 0;
    for (const g of this.instanced.values()) {
      instances += g.matrices.length;
      instancedMeshes += g.meshes.filter(Boolean).length;
    }
    return { clusters: this.clusters.length, instancedModels: this.instanced.size, instancedMeshes, instances, textureArrays: this.textures.arrays.size };
  }
}

/** Moves one vertex (position and normal, in place) from model space to its place in the world. */
export type VertexTransform = (p: THREE.Vector3, n: THREE.Vector3) => void;

function matrixTransform(m: THREE.Matrix4): VertexTransform {
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  return (p, n) => {
    p.applyMatrix4(m);
    n.applyMatrix3(nm).normalize();
  };
}

/** LOD index for a distance, or -1 past the cutoff. */
function pickLod(chain: LodChain, distance: number): number {
  if (distance > chain.cutoff) return -1;
  let lod = 0;
  while (lod < chain.switches.length && distance > chain.switches[lod]) lod++;
  return Math.min(lod, chain.names.length - 1);
}
