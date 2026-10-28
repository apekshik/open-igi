// Terrain rendering: three passes over the same surface, as the original renderer does.
//   1. base:  first material's near texture, opaque
//   2. blend: every other (material, near/far) texture, added with per-vertex weights
//   3. light: greyscale lightmap, multiplied (as 1/3 + 2/3 * lightmap)
// Ground textures live in one texture array and lightmaps in one atlas, so each pass is a single draw.
// Blending happens on the raw (gamma-space) texel values, like the original.
import * as THREE from "three";
import type { Texture } from "../formats/tex.ts";
import { buildTerrain, type BuildOptions, type LightMapAtlas, type TerrainData, type TerrainLayer } from "../level/terrain.ts";

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  in float alpha;
  in float texture;
  out vec2 vUv;
  out float vAlpha;
  flat out int vTexture;
  out float vFogDepth;
  void main() {
    vUv = uv;
    vAlpha = alpha;
    vTexture = int(texture + 0.5);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

const fogChunk = /* glsl */ `
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  float fogAmount() { return smoothstep(fogNear, fogFar, vFogDepth); }
`;

const materialFragment = /* glsl */ `
  precision highp sampler2DArray;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2DArray textures;
  in vec2 vUv;
  in float vAlpha;
  flat in int vTexture;
  in float vFogDepth;
  ${fogChunk}
  out vec4 outColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 color = texture(textures, vec3(vUv, float(vTexture))).rgb;
    outColor = vec4(mix(color, fogColor, fogAmount()) * vAlpha, 1.0);
  }
`;

const lightFragment = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D atlas;
  in vec2 vUv;
  in float vFogDepth;
  ${fogChunk}
  out vec4 outColor;
  void main() {
    #include <logdepthbuf_fragment>
    float l = 0.333333 + 0.666667 * texture(atlas, vUv).r;
    outColor = vec4(vec3(mix(l, 1.0, fogAmount())), 1.0);
  }
`;

export interface TerrainRendererOptions {
  data: TerrainData;
  textures: Texture[];
  lightMaps: { size: number; pixels: Uint8Array }[];
  origin: [number, number, number];
  radius: number;
  minLevel: number;
  detail: number;
  fog: { color: THREE.Color; near: number; far: number };
  /** Rebuild once the view has moved this far (world units). */
  rebuildDistance: number;
}

export class TerrainRenderer {
  readonly group = new THREE.Group();
  triangles = 0;
  private opts: TerrainRendererOptions;
  private atlas: LightMapAtlas;
  private materials: THREE.ShaderMaterial[];
  private meshes: THREE.Mesh[] = [];
  private lastView: [number, number, number] | null = null;

  constructor(opts: TerrainRendererOptions) {
    this.opts = opts;
    const { atlas, texture: atlasTexture } = packLightMaps(opts.lightMaps);
    this.atlas = atlas;
    const array = textureArray(opts.textures);
    // three's Color stores linear values; the shaders work in gamma space like the original.
    const fogColor = opts.fog.color.clone().convertLinearToSRGB();
    const uniforms = () => ({
      fogColor: { value: fogColor },
      fogNear: { value: opts.fog.near },
      fogFar: { value: opts.fog.far },
    });
    const shader = (fragmentShader: string, extra: Record<string, THREE.IUniform>, blending: Partial<THREE.ShaderMaterialParameters>) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader,
        fragmentShader,
        uniforms: { ...uniforms(), ...extra },
        side: THREE.DoubleSide,
        ...blending,
      });
    this.materials = [
      shader(materialFragment, { textures: { value: array } }, { blending: THREE.NoBlending }),
      shader(materialFragment, { textures: { value: array } }, {
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        depthWrite: false,
        depthFunc: THREE.LessEqualDepth,
      }),
      shader(lightFragment, { atlas: { value: atlasTexture } }, {
        blending: THREE.CustomBlending,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        depthWrite: false,
        depthFunc: THREE.LessEqualDepth,
      }),
    ];
  }

  /** Rebuild around `view` (world units) if it has moved far enough. Returns true if rebuilt. */
  update(view: [number, number, number]): boolean {
    const last = this.lastView;
    if (last && Math.max(Math.abs(view[0] - last[0]), Math.abs(view[1] - last[1]), Math.abs(view[2] - last[2])) < this.opts.rebuildDistance) {
      return false;
    }
    this.lastView = view;
    const { radius, minLevel, detail, origin } = this.opts;
    const build: BuildOptions = { view, radius, minLevel, detail, origin, atlas: this.atlas };
    const mesh = buildTerrain(this.opts.data, build);
    for (const m of this.meshes) m.geometry.dispose();
    this.group.clear();
    this.meshes = [mesh.base, mesh.blend, mesh.light].map((layer, i) => {
      const m = new THREE.Mesh(layerGeometry(layer), this.materials[i]);
      m.renderOrder = i;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.triangles = mesh.light.indices.length / 3;
    return true;
  }
}

function layerGeometry(layer: TerrainLayer): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(layer.positions, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(layer.uvs, 2));
  g.setAttribute("alpha", new THREE.BufferAttribute(layer.alpha, 1));
  g.setAttribute("texture", new THREE.BufferAttribute(layer.texture, 1));
  g.setIndex(new THREE.BufferAttribute(layer.indices, 1));
  return g;
}

function textureArray(textures: Texture[]): THREE.DataArrayTexture {
  const { width, height } = textures[0];
  const data = new Uint8Array(width * height * 4 * textures.length);
  textures.forEach((t, i) => data.set(t.rgba, i * width * height * 4));
  const array = new THREE.DataArrayTexture(data, width, height, textures.length);
  array.wrapS = array.wrapT = THREE.RepeatWrapping;
  array.magFilter = THREE.LinearFilter;
  array.minFilter = THREE.LinearMipmapLinearFilter;
  array.generateMipmaps = true;
  array.needsUpdate = true;
  return array;
}

/** Shelf-pack the lightmaps (largest first) into one greyscale atlas, plus a white texel for unlit cubes. */
function packLightMaps(maps: { size: number; pixels: Uint8Array }[]) {
  const width = 1024;
  const order = maps.map((m, i) => i).sort((a, b) => maps[b].size - maps[a].size);
  const rects: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const i of order) {
    const s = maps[i].size;
    if (x + s > width) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    rects[i] = { x, y };
    x += s;
    shelf = Math.max(shelf, s);
  }
  // A 4x4 white block on its own row.
  const white: [number, number] = [1, y + shelf + 1];
  const height = THREE.MathUtils.ceilPowerOfTwo(y + shelf + 4);
  const data = new Uint8Array(width * height * 4);
  maps.forEach((m, i) => {
    const r = rects[i];
    for (let row = 0; row < m.size; row++) {
      for (let col = 0; col < m.size; col++) {
        const v = m.pixels[row * m.size + col];
        const o = ((r.y + row) * width + r.x + col) * 4;
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
  });
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) data.fill(255, ((white[1] - 1 + row) * width + col) * 4, ((white[1] - 1 + row) * width + col) * 4 + 4);
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { atlas: { width, height, rects, white } satisfies LightMapAtlas, texture };
}
