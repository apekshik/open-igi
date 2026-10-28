// Weapon and ammo definitions: weapons/<NAME>/weapon.qvm (one DefineWeaponType call each), ammo/<NAME>/ammo.qvm
// (one DefineAmmoType call), weapons/weaponconfig.qvm (the editor's table of the same weapons, with named extra
// parameters) and humanplayer/humanplayer.qvm (the player's weapon cycle, slots and ammo limits).
//
// DefineWeaponType's 49 positional values follow the names weaponconfig.qvm declares for them; IGI.exe binds them by
// position (flawme/igi-reverse-engineering, reverse/docs/06-weapons; see THIRD_PARTY.md). Missile weapons insert the
// missile model before the weapon task type, and some weapons append type-specific values (zoom, M203, mine timings).
// See docs/formats/weapons.md.

import type { QvmCall, QvmValue } from "./qvm.ts";

export interface WeaponSpec {
  /** Numeric weapon id (argument 0). */
  index: number;
  /** Script id, e.g. "WEAPON_ID_AK47". */
  id: string;
  name: string;
  /** String table keys like "<KALASHNIKOV>". */
  manufacturer: string;
  description: string;
  /** "GUN", "PISTOL", "SHOTGUN", "GRENADE", "PROXIMITYMINE", "KNIFE", "BINOCULAR", "MEDIPACK". */
  type: string;
  /** "CROSSHAIR" or "NONE". */
  sight: string;
  /** "CLIP", "BARREL", "SHELL", "GRENADE", "NORMAL", "NONE". */
  ammoDisplay: string;
  massGrams: number;
  /** Matches an ammo type's calibre (762, 919, 10000 for hand grenades, ...); -1 for none. */
  calibre: number;
  /** Damage per bullet as a fraction of an AI soldier's health (they die at 1.0), before hit-zone multipliers. */
  damage: number;
  penetration: number;
  /** Seconds. */
  reloadTime: number;
  muzzleVelocity: number;
  /** Pellets per shot (30 for the shotguns). */
  bulletsPerRound: number;
  roundsPerMinute: number;
  /** Rounds per clip; -1 for none (knife). */
  clipSize: number;
  /** Rounds one trigger pull may fire: 1 = semi-automatic. */
  maxBurst: number;
  /** Random spread range [min, max] (see docs/formats/weapons.md for units). */
  spread: [number, number];
  /** View kick per shot in degrees: fixed and random, about X (pitch) and Z (yaw). */
  kick: { fixedX: number; fixedZ: number; randomX: number; randomZ: number };
  /** String table key, e.g. "<ASSAULT_RIFLE>". */
  category: string;
  /** Effective range in metres. */
  range: number;
  users: string;
  length: number;
  barrelLength: number;
  /** Gun model name, e.g. "100_01_1". */
  model: string;
  /** Spent casing model, "" for none. */
  casingModel: string;
  /** First-person arm animations (ids in common/anims/005.iff); -1 = none. */
  anims: { stand: number; move: number; fire: number[]; reload: number };
  /** Third-person upper-body animations for soldiers carrying it. */
  upperBody: { stand: number; walk: number; crouch: number; crouchRun: number; run: number; fire: number; reload: number };
  /** Sound names (common/sounds/<name>.wav): one shot, or a loop played while firing plus its tail. */
  fireSound: string;
  fireSoundEnd: string;
  /** "GUNSHOT" or "GUNSHOT_SILENCED" (HUMANAI_DETECTIONEVENT_<x>_RANGE). */
  detection: string;
  /** "GUNSHOT", "GRENADE", "MISSILE", "MINE", "KNIFESTAB", or "" for none. */
  projectile: string;
  /** "GUN", "GUNMP5SD", "GUNDRAGUNOV", "BINOCULAR", "MEDIPACK", ... */
  task: string;
  /** Missile weapons: the missile model. */
  missileModel?: string;
  /** Type-specific trailing values, in script order (see docs/formats/weapons.md). */
  extra: number[];
}

export interface AmmoSpec {
  index: number;
  /** "AMMO_ID_762". */
  id: string;
  name: string;
  description: string;
  calibre: number;
  /** Arguments 5..12, not yet identified (a size and two RGB triples, likely tracer/impact colours, and a flag). */
  unknown: number[];
  /** Pickup model, "" for none. */
  model: string;
  sound: string;
}

/** The player's weapon handling from humanplayer.qvm. */
export interface PlayerWeaponConfig {
  /** Weapon ids in next/previous order. */
  cycle: string[];
  /** Weapon ids per slot key (1 = knife, 2 = pistols, ...). */
  slots: string[][];
  /** Most rounds the player may carry, by ammo id. */
  ammoLimits: Map<string, number>;
  /** DefineHumanPlayerGeneral, all values in order (index 7 is the damage the player dies at). */
  general: number[];
}

const ident = (v: QvmValue | undefined): string =>
  typeof v === "string" ? v : typeof v === "object" && v && "ident" in v ? v.ident : typeof v === "number" ? String(v) : "";
const num = (v: QvmValue | undefined): number => (typeof v === "number" ? v : NaN);
const strip = (v: QvmValue | undefined, prefix: string) => ident(v).replace(prefix, "");

export function parseWeaponType(call: QvmCall): WeaponSpec {
  if (call.fn !== "DefineWeaponType") throw new Error(`not a weapon definition (${call.fn})`);
  const a = [...call.args];
  // Missile weapons (LAW 80, APC, T80) carry their missile model as a string before the weapon task type.
  let missileModel: string | undefined;
  if (typeof a[48] === "string") missileModel = a.splice(48, 1)[0] as string;
  return {
    index: num(a[0]),
    id: ident(a[1]),
    name: ident(a[2]),
    manufacturer: ident(a[3]),
    description: ident(a[4]),
    type: strip(a[5], "WEAPONTYPE_"),
    sight: strip(a[6], "SIGHTDISPLAYTYPE_"),
    ammoDisplay: strip(a[7], "AMMODISPLAYTYPE_"),
    massGrams: num(a[8]),
    calibre: num(a[9]),
    damage: num(a[10]),
    penetration: num(a[11]),
    reloadTime: num(a[12]),
    muzzleVelocity: num(a[13]),
    bulletsPerRound: num(a[14]),
    roundsPerMinute: num(a[15]),
    clipSize: num(a[16]),
    maxBurst: num(a[17]),
    spread: [num(a[18]), num(a[19])],
    kick: { fixedX: num(a[20]), fixedZ: num(a[21]), randomX: num(a[22]), randomZ: num(a[23]) },
    category: ident(a[24]),
    range: num(a[25]),
    users: ident(a[26]),
    length: num(a[27]),
    barrelLength: num(a[28]),
    model: ident(a[29]),
    casingModel: ident(a[30]),
    anims: { stand: num(a[31]), move: num(a[32]), fire: [num(a[33]), num(a[34]), num(a[35])].filter((n) => n >= 0), reload: num(a[36]) },
    upperBody: {
      stand: num(a[37]),
      walk: num(a[38]),
      crouch: num(a[39]),
      crouchRun: num(a[40]),
      run: num(a[41]),
      fire: num(a[42]),
      reload: num(a[43]),
    },
    fireSound: ident(a[44]),
    fireSoundEnd: ident(a[45]),
    detection: strip(a[46], "HUMANAI_DETECTIONEVENT_").replace(/_RANGE$/, ""),
    projectile: typeof a[47] === "number" ? "" : strip(a[47], "TASKTYPE_"),
    task: strip(a[48], "TASKTYPE_"),
    missileModel,
    extra: a.slice(49).map(num),
  };
}

export function parseAmmoType(call: QvmCall): AmmoSpec {
  if (call.fn !== "DefineAmmoType") throw new Error(`not an ammo definition (${call.fn})`);
  const a = call.args;
  return {
    index: num(a[0]),
    id: ident(a[1]),
    name: ident(a[2]),
    description: ident(a[3]),
    calibre: num(a[4]),
    unknown: a.slice(5, 13).map(num),
    model: ident(a[13]),
    sound: ident(a[14]),
  };
}

/**
 * Named extra parameters per weapon id from weaponconfig.qvm (`TagItemReal32` / `TagItemString16` children of each
 * `WeaponConfig` task), e.g. "Grenade - Explosion radius (meters)" → 7 for WEAPON_ID_GRENADE.
 */
export function parseWeaponConfigTags(statements: QvmCall[]): Map<string, Map<string, number | string>> {
  const out = new Map<string, Map<string, number | string>>();
  const visit = (task: QvmCall) => {
    if (task.fn !== "Task_New") return;
    const [, type, , ...rest] = task.args;
    if (type === "WeaponConfig") {
      const tags = new Map<string, number | string>();
      for (const child of rest) {
        if (typeof child !== "object" || !("fn" in child) || child.fn !== "Task_New") continue;
        const [, t, , key, value] = child.args;
        if ((t === "TagItemReal32" || t === "TagItemString16") && typeof key === "string") tags.set(key, value as number | string);
      }
      out.set(ident(rest[1]), tags);
    }
    for (const child of rest) if (typeof child === "object" && "fn" in child) visit(child);
  };
  for (const s of statements) visit(s);
  return out;
}

export function parsePlayerWeapons(statements: QvmCall[]): PlayerWeaponConfig {
  const config: PlayerWeaponConfig = { cycle: [], slots: [], ammoLimits: new Map(), general: [] };
  for (const s of statements) {
    if (s.fn === "DefineHumanPlayerWeaponCycle") config.cycle = s.args.map(ident);
    else if (s.fn === "DefineHumanPlayerGeneral") config.general = s.args.map(num);
    else if (s.fn === "DefineHumanPlayerAmmoLimit") {
      for (let i = 0; i + 1 < s.args.length; i += 2) config.ammoLimits.set(ident(s.args[i]), num(s.args[i + 1]));
    } else if (s.fn === "DefineHumanPlayerWeaponCategory") {
      // Runs of: count, weapon id x count.
      for (let i = 0; i < s.args.length; ) {
        const n = num(s.args[i++]);
        config.slots.push(s.args.slice(i, i + n).map(ident));
        i += n;
      }
    }
  }
  return config;
}
