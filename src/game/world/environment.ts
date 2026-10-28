// A level's environment as objects.qvm describes it in its "EnvironmentalEffects" container: sky dome colours and
// cloud layers (FlatSky, FlatSkyLayer), fog and ambient light (GlobalLightKeyframe), the sun (DirlightKeyframe) and
// level-of-detail distances (LODSettings). Parameter layouts come from each type's Task_DeclareParameters call; how the
// engine uses them follows hjcminus/Project-IGI-Terrain where it covers them (sky, fog), see docs/formats/world.md.

import type { QvmCall, QvmValue } from "../../formats/qvm.ts";
import { METRE } from "../coords.ts";

export type Rgb = [number, number, number];

export interface SkyLayer {
  /** Texture path (missions/location0/common/textures/sky_layer1.tex). */
  texture: string;
  /** Texture repeats per world unit on the layer plane. */
  scale: number;
  /** Scroll per game tick (1/30 s), in texture repeats. */
  speed: [number, number];
  color: Rgb;
  alpha: number;
}

export interface Environment {
  sky: {
    /** Cloud fade: 0 = layers fully visible to the horizon, 1 = fade starts at the camera. */
    fogAmount: number;
    /** Height of the cloud plane above the eye, metres (only its ratio to `distance` matters). */
    height: number;
    /** Forward distance at which clouds have faded out, metres. */
    distance: number;
    /** Clear colour behind the dome. */
    fogColor: Rgb;
    /** Angle above the horizon where the dome turns from the middle to the top colours, radians. */
    domeAngle: number;
    top: Rgb;
    middle: [Rgb, Rgb];
    bottom: [Rgb, Rgb];
    layers: SkyLayer[];
  };
  /** Linear fog in world units (radial distance from the eye). */
  fog: { color: Rgb; near: number; far: number };
  /** Ambient light on terrain and objects (the colour shadowed faces get). */
  ambient: Rgb;
  sun: {
    /** Unit vector towards the sun, IGI space. */
    direction: [number, number, number];
    /** Light on faces turned to the sun ("Front Color"). */
    front: Rgb;
    /** Light on faces turned away ("Back Color"). */
    back: Rgb;
  };
  /** LODSettings: switch and cutoff distances relative to object radius. */
  lod: {
    firstSwitch: { spline: number; rigid: number; bone: number };
    cutoff: { spline: number; rigid: number; bone: number };
    /** How much radius affects LOD distances (0 = not at all, 1 = proportional). */
    radiusExponent: number;
    /** Radius (metres) at which the factors apply as given. */
    idealRadius: number;
  };
}

// Engine defaults where a level leaves something out: Mission 1's values.
const DEFAULT: Environment = {
  sky: {
    fogAmount: 0.94,
    height: 4,
    distance: 100,
    fogColor: [0.2, 0.29, 0.4],
    domeAngle: (15 * Math.PI) / 180,
    top: [0.12, 0.19, 0.62],
    middle: [
      [0.4, 0.6, 0.67],
      [0.4, 0.6, 0.67],
    ],
    bottom: [
      [0.71, 0.62, 0.52],
      [0.71, 0.62, 0.52],
    ],
    layers: [],
  },
  fog: { color: [0.58, 0.54, 0.48], near: 1250 * METRE, far: 3700 * METRE },
  ambient: [0.27, 0.29, 0.33],
  sun: { direction: [0, 0, 1], front: [1, 0.77, 0.62], back: [0.27, 0.29, 0.33] },
  lod: {
    firstSwitch: { spline: 50, rigid: 65, bone: 65 },
    cutoff: { spline: 2450, rigid: 2450, bone: 1600 },
    radiusExponent: 0.25,
    idealRadius: 15,
  },
};

/** The time of day every mission is lit for (GlobalLightKeyframe/DirlightKeyframe "Time"; the other keyframe is 100). */
const TIME_OF_DAY = 12;

// hjcminus/Project-IGI-Terrain derives the fog end from the density as 7200 / density in its renderer units
// (1/1000 of a world unit) and starts the fog at a third of that.
const FOG_FAR_PER_DENSITY = 7200 * 1000;
const FOG_NEAR_FRACTION = 1 / 3;

export function readEnvironment(statements: QvmCall[]): Environment {
  const env: Environment = structuredClone(DEFAULT);
  const tasks = new Map<string, QvmValue[][]>();
  const visit = (t: QvmCall) => {
    if (t.fn !== "Task_New") return;
    const [, type, , ...rest] = t.args;
    const list = tasks.get(String(type)) ?? [];
    list.push(rest.filter((r) => !isCall(r)));
    tasks.set(String(type), list);
    for (const c of rest) if (isCall(c)) visit(c);
  };
  statements.forEach(visit);
  const num = (v: QvmValue | undefined, fallback: number) => (typeof v === "number" ? v : fallback);
  const rgb = (p: QvmValue[], at: number, fallback: Rgb): Rgb => [num(p[at], fallback[0]), num(p[at + 1], fallback[1]), num(p[at + 2], fallback[2])];
  // The keyframe closest to the mission's time of day.
  const keyframe = (list: QvmValue[][] | undefined, timeAt: (p: QvmValue[]) => number) =>
    list?.slice().sort((a, b) => Math.abs(timeAt(a) - TIME_OF_DAY) - Math.abs(timeAt(b) - TIME_OF_DAY))[0];

  // FlatSky: fog amount, z pos, distance, fog colour, snap colours, dome angle, top, middle 1, middle 2, bottom 1, bottom 2.
  const sky = tasks.get("FlatSky")?.[0];
  if (sky) {
    const s = env.sky;
    s.fogAmount = num(sky[0], s.fogAmount);
    s.height = num(sky[1], s.height);
    s.distance = num(sky[2], s.distance);
    s.fogColor = rgb(sky, 3, s.fogColor);
    s.domeAngle = (num(sky[7], (s.domeAngle * 180) / Math.PI) * Math.PI) / 180;
    s.top = rgb(sky, 8, s.top);
    s.middle = [rgb(sky, 11, s.middle[0]), rgb(sky, 14, s.middle[1])];
    s.bottom = [rgb(sky, 17, s.bottom[0]), rgb(sky, 20, s.bottom[1])];
  }
  // FlatSkyLayer: texture, scale, x speed, y speed, alpha, colour.
  for (const l of tasks.get("FlatSkyLayer") ?? []) {
    if (typeof l[0] !== "string") continue;
    env.sky.layers.push({
      texture: l[0],
      scale: num(l[1], 1),
      speed: [num(l[2], 0), num(l[3], 0)],
      alpha: num(l[4], 1),
      color: rgb(l, 5, [1, 1, 1]),
    });
  }

  // GlobalLightKeyframe: link-all button, then per category (terrain, objects 1-4) ambient RGB, fog RGB, fog density,
  // link setting; then sky colour, water ambient, water colour, time.
  const light = keyframe(tasks.get("GlobalLightKeyframe"), (p) => num(p[50], TIME_OF_DAY));
  if (light) {
    env.ambient = rgb(light, 1, env.ambient);
    const density = num(light[7], 0);
    env.fog.color = rgb(light, 4, env.fog.color);
    if (density > 0) {
      env.fog.far = FOG_FAR_PER_DENSITY / density;
      env.fog.near = env.fog.far * FOG_NEAR_FRACTION;
    }
  }

  // DirlightKeyframe: beta (elevation), gamma (heading), front colour, back colour, time.
  const sun = keyframe(tasks.get("DirlightKeyframe"), (p) => num(p[8], TIME_OF_DAY));
  if (sun) {
    const beta = num(sun[0], Math.PI / 4);
    const gamma = num(sun[1], 0);
    const c = Math.cos(beta);
    env.sun.direction = [-Math.sin(gamma) * c, Math.cos(gamma) * c, Math.sin(beta)];
    env.sun.front = rgb(sun, 2, env.sun.front);
    env.sun.back = rgb(sun, 5, env.sun.back);
  }

  // LODSettings: first switch (spline, rigid, bone), cutoff (spline, rigid, bone), radius exponent, ideal radius.
  const lod = tasks.get("LODSettings")?.[0];
  if (lod) {
    const l = env.lod;
    l.firstSwitch = { spline: num(lod[0], 50), rigid: num(lod[1], 65), bone: num(lod[2], 65) };
    l.cutoff = { spline: num(lod[3], 2450), rigid: num(lod[4], 2450), bone: num(lod[5], 1600) };
    l.radiusExponent = num(lod[6], l.radiusExponent);
    l.idealRadius = num(lod[7], l.idealRadius);
  }
  return env;
}

function isCall(v: QvmValue): v is QvmCall {
  return typeof v === "object" && "fn" in v;
}
