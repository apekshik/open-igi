// Loads IGI's weapon and ammo definitions from the install: weapons/*/weapon.qvm, ammo/*/ammo.qvm,
// weapons/weaponconfig.qvm (named extras such as grenade radii) and humanplayer/humanplayer.qvm (slots, ammo limits).
import { decodeQvm } from "../../formats/qvm.ts";
import {
  parseAmmoType,
  parsePlayerWeapons,
  parseWeaponConfigTags,
  parseWeaponType,
  type AmmoSpec,
  type PlayerWeaponConfig,
  type WeaponSpec,
} from "../../formats/weapon.ts";
import type { Vfs } from "../../vfs/vfs.ts";

export interface WeaponData {
  weapons: Map<string, WeaponSpec>;
  ammo: Map<string, AmmoSpec>;
  /** Ammo id by calibre (762 → "AMMO_ID_762"). */
  ammoByCalibre: Map<number, string>;
  /** weaponconfig.qvm extras by weapon id, by tag name. */
  tags: Map<string, Map<string, number | string>>;
  player: PlayerWeaponConfig;
}

async function readAll<T>(vfs: Vfs, pattern: RegExp, parse: (bytes: Uint8Array) => T | null): Promise<T[]> {
  const paths = vfs.list().filter((p) => pattern.test(p));
  const out = await Promise.all(
    paths.map(async (p) => {
      try {
        return parse(await vfs.read(p));
      } catch (e) {
        console.warn(`weapons: cannot read ${p}:`, e);
        return null;
      }
    }),
  );
  return out.filter((x): x is Awaited<T> & {} => x !== null) as T[];
}

const first = (bytes: Uint8Array, fn: string) => decodeQvm(bytes).find((c) => c.fn === fn) ?? null;

export async function loadWeaponData(vfs: Vfs): Promise<WeaponData> {
  const [weapons, ammo, config, player] = await Promise.all([
    readAll(vfs, /^weapons\/[^/]+\/weapon\.qvm$/i, (b) => {
      const c = first(b, "DefineWeaponType");
      return c ? parseWeaponType(c) : null;
    }),
    readAll(vfs, /^ammo\/[^/]+\/ammo\.qvm$/i, (b) => {
      const c = first(b, "DefineAmmoType");
      return c ? parseAmmoType(c) : null;
    }),
    vfs.has("weapons/weaponconfig.qvm") ? vfs.read("weapons/weaponconfig.qvm").then(decodeQvm) : Promise.resolve([]),
    vfs.has("humanplayer/humanplayer.qvm") ? vfs.read("humanplayer/humanplayer.qvm").then(decodeQvm) : Promise.resolve([]),
  ]);
  const data: WeaponData = {
    weapons: new Map(weapons.map((w) => [w.id, w])),
    ammo: new Map(ammo.map((a) => [a.id, a])),
    ammoByCalibre: new Map(ammo.map((a) => [a.calibre, a.id])),
    tags: parseWeaponConfigTags(config),
    player: parsePlayerWeapons(player),
  };
  return data;
}

/** A weaponconfig.qvm extra, e.g. tag(data, "WEAPON_ID_GRENADE", "Grenade - Explosion radius (meters)"). */
export function tag(data: WeaponData, weaponId: string, name: string, fallback: number): number {
  const v = data.tags.get(weaponId)?.get(name);
  return typeof v === "number" ? v : fallback;
}

/**
 * Type-specific trailing values of DefineWeaponType, named. weapon.qvm lists them without names; their order matches
 * the TagItem children of the same weapon in weaponconfig.qvm (see docs/formats/weapons.md).
 */
export interface WeaponExtras {
  minFov?: number;
  maxFov?: number;
  defaultFov?: number;
  zoomMinFov?: number;
  armTime?: number;
  countdown?: number;
  activateRadius?: number;
  radius?: number;
  falloff?: number;
  damage?: number;
  healPerRound?: number;
  m203Velocity?: number;
  m203Radius?: number;
  m203Activate?: number;
}

export function extras(data: WeaponData, w: WeaponSpec): WeaponExtras {
  const x = (i: number, tagName: string, fallback: number) => w.extra[i] ?? tag(data, w.id, tagName, fallback);
  switch (w.type) {
    case "BINOCULAR":
      return { minFov: x(0, "Binocular - Min FOV (degrees)", 5), maxFov: x(1, "Binocular - Max FOV (degrees)", 90), defaultFov: x(2, "Binocular - Default FOV (degrees)", 70) };
    case "PROXIMITYMINE":
      return {
        armTime: x(0, "Proximitymine - Time before arming (seconds)", 3),
        countdown: x(1, "Proximitymine - Countdown time (seconds)", 0.5),
        activateRadius: x(2, "Proximitymine - Activate radius (meters)", 2.5),
        radius: x(3, "Proximitymine - Explosion radius (meters)", 3.5),
      };
    case "GRENADE":
      return {
        radius: tag(data, w.id, "Grenade - Explosion radius (meters)", 7),
        falloff: tag(data, w.id, "Grenade - Explosion falloff (meters)", 4),
        damage: tag(data, w.id, "Grenade - Explosion damage factor", 1),
      };
    case "MEDIPACK":
      return { healPerRound: x(0, "Factor of human max damage to add for each round", 0.01) };
  }
  if (w.task === "GUNM16A2") {
    return {
      m203Velocity: x(0, "M203 - Muzzle velocity (km/h)", 270),
      m203Radius: x(1, "M203 - Explosion radius (meters)", 5),
      m203Activate: x(2, "M203 - Activate radius (meters)", 1),
    };
  }
  if (w.task === "GUNDRAGUNOV" || w.task === "GUNMP5SD") return { zoomMinFov: x(0, "Zoom - Min FOV (degrees)", 30) };
  return {};
}
