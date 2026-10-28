// IGI's sky: a vertex-coloured dome around the eye (FlatSky's top/middle/bottom colours) with textured cloud layers
// (FlatSkyLayer) on a flat plane a fixed height above the eye that fade out with forward distance. Both follow the
// camera, so the sky never parallaxes. Colours are used as raw (gamma-space) values, as the original renderer does.
// Dome shape, colour interpolation and the cloud fade follow hjcminus/Project-IGI-Terrain (MIT, see THIRD_PARTY.md):
// source/renderer/renderer_skydome.cpp and source/level/flat_sky_layer.cpp.
import * as THREE from "three";
import type { Texture } from "../formats/tex.ts";

type Rgb = [number, number, number];

export interface SkyOptions {
  /** World units per metre. */
  metre: number;
  domeAngle: number;
  top: Rgb;
  middle: [Rgb, Rgb];
  bottom: [Rgb, Rgb];
  /** Cloud plane height above the eye and fade distance, metres. */
  height: number;
  distance: number;
  fogAmount: number;
  layers: { texture: Texture; scale: number; speed: [number, number]; color: Rgb; alpha: number }[];
}

const STACKS = 15;
const SLICES = 20;
// Game ticks per second for the cloud scroll speeds (objects.qvm uses GAME_FREQUENCY ticks).
const TICKS_PER_SECOND = 30;
// The engine's near plane, the distance from which clouds may start to fade.
const Z_NEAR_METRES = 0.1;

const domeVertex = /* glsl */ `
  in vec3 color;
  out vec3 vColor;
  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // on the far plane
  }
`;

const domeFragment = /* glsl */ `
  in vec3 vColor;
  out vec4 outColor;
  void main() { outColor = vec4(vColor, 1.0); }
`;

const layerVertex = /* glsl */ `
  out vec2 vRel;
  out float vDepth;
  void main() {
    // The plane is centred on the eye; IGI x = three x, IGI y = -three z.
    vRel = vec2(position.x, -position.z);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w * 0.999999;
  }
`;

const layerFragment = /* glsl */ `
  uniform sampler2D map;
  uniform float scale;
  uniform vec2 offset;
  uniform vec3 color;
  uniform float alpha;
  uniform float fogStart;
  uniform float fadeEnd;
  in vec2 vRel;
  in float vDepth;
  out vec4 outColor;
  void main() {
    vec4 tex = texture(map, vRel * scale + offset);
    float z = max(vDepth, 1e-3);
    float fade = z < fogStart ? 1.0 : clamp((fogStart / z) * ((fadeEnd - z) / (fadeEnd - fogStart)), 0.0, 0.999);
    outColor = tex * vec4(color, alpha * fade);
  }
`;

export class SkyRenderer {
  /** Add to the scene (three.js space, not the IGI world group). */
  readonly group = new THREE.Group();
  private layers: { material: THREE.ShaderMaterial; speed: [number, number]; offset: THREE.Vector2 }[] = [];

  constructor(opts: SkyOptions) {
    const radius = 1000 * opts.metre;
    const dome = new THREE.Mesh(
      domeGeometry(opts, radius),
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: domeVertex,
        fragmentShader: domeFragment,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    dome.renderOrder = -100;
    dome.frustumCulled = false;
    this.group.add(dome);

    // Clouds: a square big enough to reach past the fade distance in every direction.
    const height = opts.height * opts.metre;
    const fadeEnd = opts.distance * opts.metre;
    const fogStart = fadeEnd - (fadeEnd - Z_NEAR_METRES * opts.metre) * opts.fogAmount;
    const plane = new THREE.PlaneGeometry(fadeEnd * 4, fadeEnd * 4, 8, 8).rotateX(-Math.PI / 2).translate(0, height, 0);
    opts.layers.forEach((l, i) => {
      const map = new THREE.DataTexture(l.texture.rgba, l.texture.width, l.texture.height);
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.magFilter = THREE.LinearFilter;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.generateMipmaps = true;
      map.needsUpdate = true;
      const offset = new THREE.Vector2();
      const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: layerVertex,
        fragmentShader: layerFragment,
        uniforms: {
          map: { value: map },
          scale: { value: l.scale },
          offset: { value: offset },
          color: { value: new THREE.Vector3(...l.color) },
          alpha: { value: l.alpha },
          fogStart: { value: fogStart },
          fadeEnd: { value: fadeEnd },
        },
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        // Custom blending stays on in the opaque pass, which draws first, so the world covers the sky.
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      const mesh = new THREE.Mesh(plane, material);
      mesh.renderOrder = -99 + i;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.layers.push({ material, speed: l.speed, offset });
    });
  }

  /** Follow the eye and scroll the clouds. */
  update(dt: number, eye: THREE.Vector3) {
    this.group.position.copy(eye);
    for (const l of this.layers) {
      l.offset.x = (l.offset.x + l.speed[0] * dt * TICKS_PER_SECOND) % 1;
      l.offset.y = (l.offset.y + l.speed[1] * dt * TICKS_PER_SECOND) % 1;
    }
  }
}

/** The dome as the engine builds it: a pole, 15 rings of 20 vertices down to the horizon, and a skirt below. */
function domeGeometry(opts: SkyOptions, radius: number): THREE.BufferGeometry {
  const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp = (c: Rgb): Rgb => c.map((v) => Math.min(1, Math.max(0, v))) as Rgb;
  // Colour from the four corners (c1, c2 across a ring, c3, c4 down to the next band).
  const mix = (c: Rgb[], f1: number, f2: number) => clamp(lerp(lerp(c[0], c[1], f1), lerp(c[2], c[3], f1), f2));
  const top = opts.top;
  const upper = [top, top, opts.middle[0], opts.middle[1]];
  const lower = [opts.middle[0], opts.middle[1], opts.bottom[0], opts.bottom[1]];

  const positions: number[] = [];
  const colors: number[] = [];
  // IGI (x, y, z) → three (x, z, -y).
  const push = (x: number, y: number, z: number, c: Rgb) => {
    positions.push(x, z, -y);
    colors.push(...c);
  };
  push(0, 0, radius, clamp(top));
  const ring: Rgb[] = [];
  let pitch = Math.PI / 2;
  let t1 = 0;
  for (let i = 0; i < STACKS; i++) {
    pitch -= Math.PI / 2 / STACKS;
    let corners: Rgb[];
    let t: number;
    if (pitch < opts.domeAngle) {
      corners = lower;
      const half = opts.domeAngle / 2;
      t = pitch < half ? 0 : pitch / half - 1;
    } else {
      corners = upper;
      t = (pitch - opts.domeAngle) / (Math.PI / 2 - opts.domeAngle);
    }
    const f1 = t1 >= 1 ? t1 - 1 : 1 - t1;
    const color = mix(corners, f1, 1 - t);
    for (let j = 0; j < SLICES; j++) {
      const yaw = (j / SLICES) * Math.PI * 2;
      push(Math.cos(yaw) * radius * Math.cos(pitch), Math.sin(yaw) * radius * Math.cos(pitch), radius * Math.sin(pitch), color);
    }
    ring[i] = color;
    t1 += 0.1;
  }
  // Skirt: the last ring extruded downwards.
  for (let j = 0; j < SLICES; j++) {
    const yaw = (j / SLICES) * Math.PI * 2;
    push(Math.cos(yaw) * radius, Math.sin(yaw) * radius, -radius * 0.5, ring[STACKS - 1]);
  }

  const indices: number[] = [];
  for (let j = 0, k = SLICES - 1; j < SLICES; k = j++) indices.push(0, 1 + j, 1 + k);
  for (let i = 0; i < STACKS; i++) {
    for (let j = 0, k = SLICES - 1; j < SLICES; k = j++) {
      const a = 1 + SLICES * i + k;
      const b = 1 + SLICES * i + j;
      indices.push(a, b, b + SLICES, b + SLICES, a + SLICES, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  return g;
}
