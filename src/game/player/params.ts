// Jones's tuning, read from the player's own install: humanplayer/humanplayer.qvm (DefineHumanPlayerGeneral) and
// material/material.qvm (footstep sounds and how far AI hears them). Every value has the shipped default as a
// fallback so the controller still works without those files. Meanings and units: docs/formats/player.md.
import { decodeQvm, type QvmCall, type QvmValue } from "../../formats/qvm.ts";
import { METRE } from "../coords.ts";
import type { Vfs } from "../../vfs/vfs.ts";

const KMH = METRE / 3.6;

export interface PlayerParams {
  /** Multiplier on the animations' root motion (arg 0): the player moves 1.75x as fast as the clips' feet. */
  rootMotionScale: number;
  /** Horizontal take-off speed of a jump along the current movement direction, units/s (arg 1, km/h). */
  jumpSpeed: number;
  /** Vertical take-off speed of a jump, units/s (arg 2, km/h). */
  jumpUpSpeed: number;
  /** Air control: acceleration from the move keys while airborne, units/s² (arg 3, km/h per 30 Hz tick). */
  airControl: number;
  /** Lean: sideways eye offset (arg 4, m) and the upward peek offset while crouched (arg 5, m), in units. */
  leanSide: number;
  leanUp: number;
  /** Time to reach a full lean, seconds (arg 6; the exe truncates it to whole 30 Hz ticks). */
  leanTime: number;
  /** Damage the player can take before dying (arg 7). AI soldiers die at 1.0. */
  maxHealth: number;
  /** Damage multiplier per hit zone 0..16 (args 9..25): 4 limbs x (distal, middle, proximal), torso, front, back, head. */
  hitZones: number[];
}

export const DEFAULT_PARAMS: PlayerParams = {
  rootMotionScale: 1.75,
  jumpSpeed: 17.5 * KMH,
  jumpUpSpeed: 27 * KMH,
  airControl: 0.5 * KMH * 30,
  leanSide: 0.85 * METRE,
  leanUp: 0.85 * METRE,
  leanTime: Math.trunc(0.25 * 30) / 30,
  maxHealth: 3,
  hitZones: [0.5, 0.75, 1, 0.5, 0.75, 1, 0.5, 0.75, 1, 0.5, 0.75, 1, 1, 1, 1, 1, 1],
};

/** Engine constants of the player's movement (IGI.exe; see docs/formats/player.md). Units and seconds. */
export const PHYSICS = {
  /** Gravity on the player while jumping or falling: 84.74 units per tick² at 30 Hz = 18.62 m/s². */
  gravity: 84.741692 * 900,
  /** Landing speed (m/s) where fall damage starts, and the extra speed that does the player's full health. */
  fallDamageFrom: 14,
  fallDamageRange: 13,
  /** Ground snap while grounded: walking off a step lower than this keeps the feet on the ground. */
  stepDown: 0.5 * METRE,
  /** Knock-back speed from a bullet hit (5 km/h), decaying x0.9 per 30 Hz tick. */
  bulletKnock: 5 * KMH,
  knockDecay: 0.9,
  /** View offset above the pelvis: standing and crouched (the AI's target point and the map-computer eye). */
  eyeAbovePelvis: 0.69 * METRE,
  eyeAbovePelvisLow: 0.35 * METRE,
  /** Collision heights: the exe's wall probes reach 1.8 m standing and 1.3 m crouched. */
  heightStand: 1.8 * METRE,
  heightCrouch: 1.3 * METRE,
  /** No collision radius is known (the exe casts zero-width rays against inflated hulls); this keeps the eye off walls. */
  radius: 0.3 * METRE,
  /** Noise radius of a landing, without and with fall damage. */
  landNoise: 5 * METRE,
  landNoiseHurt: 10 * METRE,
};

export interface GroundMaterial {
  name: string;
  /** How far AI hears a footstep on it (units); 0 = silent. */
  footstepRange: number;
  /** Footstep sound names (common/sounds/<name>.wav), empty entries removed. */
  steps: string[];
  land: string;
}

const GROUND: GroundMaterial = {
  name: "Ground",
  footstepRange: 1 * METRE,
  steps: [1, 2, 3, 4, 5, 6].map((i) => `walk_ground_${i}`),
  land: "land_ground_1",
};

export interface PlayerData {
  params: PlayerParams;
  /** Ground materials by lower-case name (material.qvm DefineGameMaterial). */
  materials: Map<string, GroundMaterial>;
  /** Footstep event times (animation ticks, 4800/s) per clip id of skeleton 000, from the clips' BOED chunks. */
  footsteps: Map<number, number[]>;
  /** Hand-and-foot step events (type 8) of the ladder clips: 168 (climb) has two per cycle, 170 (off the top) four. */
  ladderSteps: Map<number, number[]>;
}

const num = (v: QvmValue | undefined, fallback: number) => (typeof v === "number" ? v : fallback);

async function script(vfs: Vfs, path: string): Promise<QvmCall[]> {
  if (!vfs.has(path)) return [];
  try {
    return decodeQvm(await vfs.read(path));
  } catch (err) {
    console.warn(`player: cannot read ${path}`, err);
    return [];
  }
}

export function readParams(calls: QvmCall[]): PlayerParams {
  const call = calls.find((c) => c.fn === "DefineHumanPlayerGeneral");
  if (!call) return DEFAULT_PARAMS;
  const a = call.args;
  const d = DEFAULT_PARAMS;
  return {
    rootMotionScale: num(a[0], d.rootMotionScale),
    jumpSpeed: num(a[1], 17.5) * KMH,
    jumpUpSpeed: num(a[2], 27) * KMH,
    airControl: num(a[3], 0.5) * KMH * 30,
    leanSide: num(a[4], 0.85) * METRE,
    leanUp: num(a[5], 0.85) * METRE,
    leanTime: Math.max(1, Math.trunc(num(a[6], 0.25) * 30)) / 30,
    maxHealth: num(a[7], d.maxHealth),
    hitZones: d.hitZones.map((m, i) => num(a[9 + i], m)),
  };
}

export function readMaterials(calls: QvmCall[]): Map<string, GroundMaterial> {
  const out = new Map<string, GroundMaterial>([["ground", GROUND]]);
  for (const c of calls) {
    if (c.fn !== "DefineGameMaterial" || typeof c.args[0] !== "string") continue;
    const s = (i: number) => (typeof c.args[i] === "string" ? (c.args[i] as string) : "");
    // name, ?, ?, ?, ?, footstep range (m), 6 footstep sounds, landing sound, rain sound, bullet sounds...
    const steps = [6, 7, 8, 9, 10, 11].map(s).filter((n) => n && n !== "Walk0");
    out.set(c.args[0].toLowerCase(), { name: c.args[0], footstepRange: num(c.args[5], 0) * METRE, steps, land: s(12) });
  }
  return out;
}

/**
 * Footstep events of every clip in an .iff animation file. Each BOAN's BOED holds 24-byte events
 * `{u32 type, u32 bone, f32 time, vec3 offset}`; type 1010 is a footstep (the bone is the foot that lands). Type 8
 * marks the steps of the ladder clips (168, 170) and the crawl (172); the reload clips use the AnimTrigger ids
 * of animtrigger.qvm (1000+) instead.
 * src/formats/anim.ts skips BOED, so this reads the chunk stream itself with the same flat walk.
 */
export function readFootsteps(bytes: Uint8Array, type = 1010): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  let at = 0;
  let id = -1;
  while (at + 8 <= bytes.length) {
    const t = tag(at);
    if (t === "FORM") {
      at += 12;
      continue;
    }
    const size = view.getUint32(at + 4, false);
    if (at + 8 + size > bytes.length) break;
    const p = at + 8;
    if (t === "BOAH") id = view.getUint32(p + 8, true);
    else if (t === "BOED") {
      const times: number[] = [];
      for (let o = 0; o + 24 <= size; o += 24) if (view.getUint32(p + o, true) === type) times.push(view.getFloat32(p + o + 8, true));
      if (times.length) out.set(id, times);
    }
    at += 8 + size + (size & 1);
  }
  return out;
}

export async function loadPlayerData(vfs: Vfs): Promise<PlayerData> {
  const [human, material] = await Promise.all([script(vfs, "humanplayer/humanplayer.qvm"), script(vfs, "material/material.qvm")]);
  let footsteps = new Map<number, number[]>();
  let ladderSteps = new Map<number, number[]>();
  if (vfs.has("common/anims/000.iff")) {
    const anims = await vfs.read("common/anims/000.iff");
    footsteps = readFootsteps(anims);
    ladderSteps = readFootsteps(anims, 8);
  }
  return { params: readParams(human), materials: readMaterials(material), footsteps, ladderSteps };
}

export function groundMaterial(data: PlayerData, name: string | undefined): GroundMaterial {
  return (name && data.materials.get(name.toLowerCase())) || data.materials.get("ground") || GROUND;
}
