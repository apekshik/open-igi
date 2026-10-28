import type { Vec3 } from "../coords.ts";
import type { AmmoSpec, WeaponSpec } from "../../formats/weapon.ts";

export type { AmmoSpec, WeaponSpec };

export interface WeaponState {
  /** Weapon id as the game names it (e.g. "WEAPON_ID_AK47"). */
  id: string;
  name: string;
  clip: number;
  clipSize: number;
  /** Rounds in reserve, not counting the clip. */
  reserve: number;
}

/** What the player is looking through: binoculars, a sniper scope, a plain zoom (MP5SD), or nothing. */
export type ZoomKind = "binoculars" | "scope" | "zoom" | null;

export interface FireOptions {
  /** Scales the damage dealt (AI "Damage scale" per type and difficulty). Default 1. */
  damageScale?: number;
  /** Extra random spread in degrees on top of the weapon's own (AI aim error). */
  spread?: number;
  /** Skip the muzzle flash, tracer and sound (e.g. off-screen shooters). */
  quiet?: boolean;
}

export interface ShotResult {
  /** Where each pellet stopped (null if it hit nothing within range). */
  hits: { point: Vec3; entityId: number | null; part?: string }[];
}

export interface WeaponsService {
  /** The player's weapon in hand, or null (unarmed / binoculars). */
  current(): WeaponState | null;
  /** The player's inventory in slot order. */
  inventory(): WeaponState[];
  /**
   * Give an entity a weapon (pickups, level start loadout). For the player `rounds` goes to the clip first and the
   * rest to the reserve of its calibre; for other entities it records their loadout (dropped on death).
   */
  give(entityId: number, weaponId: string, rounds: number): void;

  /** Weapon and ammo definitions from the game files, by id ("WEAPON_ID_AK47", "AMMO_ID_762"). */
  spec(weaponId: string): WeaponSpec | undefined;
  ammo(ammoId: string): AmmoSpec | undefined;
  /** Add rounds of an ammo type to the player's reserve (capped by humanplayer.qvm's limits). Returns rounds taken. */
  addAmmo(ammoId: string, rounds: number): number;
  /** Put a weapon in the player's hands (if carried). */
  select(weaponId: string): boolean;
  /** Current zoom view, for the HUD (also sent as "weapon:zoom" events). */
  zoom(): { kind: ZoomKind; fov: number };
  /** Draw the built-in binocular/scope overlay (the UI may turn this off and draw its own on "weapon:zoom"). */
  drawOverlay: boolean;

  /**
   * Fire a weapon for anyone (AI soldiers, turrets) with the same ballistics as the player's: spread, pellets, range,
   * hit zones, damage, effects, sound, "weapon:fire" and "noise" events. Does not use ammo; the caller paces shots
   * with `spec().roundsPerMinute` and reloads with `spec().reloadTime`. Thrown and missile weapons launch their
   * projectile along `direction`.
   */
  fire(ownerId: number, weaponId: string, origin: Vec3, direction: Vec3, options?: FireOptions): ShotResult;
  /**
   * Apply damage to an entity: lowers its health, emits "damage" and, when health reaches 0, "death".
   * The weapons system is the single place health goes down; owners react to the events and must not subtract again.
   */
  applyDamage(targetId: number, amount: number, sourceId: number | null, point: Vec3, direction: Vec3, part?: string): void;
  /** An explosion with IGI's radius/falloff damage, effects, sound and noise. */
  explode(position: Vec3, sourceId: number | null, radius: number, falloff: number, damage: number, kind?: string): void;
}

declare module "../events.ts" {
  interface GameEvents {
    /** The player's zoom view changed; `fov` is the field of view in degrees. */
    "weapon:zoom": { ownerId: number; kind: ZoomKind; fov: number; weapon: string };
    /** The player's weapon in hand changed (null = none). */
    "weapon:switch": { ownerId: number; weapon: string | null };
    "weapon:reload": { ownerId: number; weapon: string };
    /** A bullet hit something (for decals, sounds, AI "bullet whizz" reactions). */
    "weapon:impact": { ownerId: number; weapon: string; point: Vec3; normal: Vec3; entityId: number | null; part?: string };
    explosion: { position: Vec3; radius: number; sourceId: number | null; kind: string };
    /** A flashbang went off; `strength` 0..1 at the player's eye (0 = not seen). */
    flash: { position: Vec3; strength: number };
  }
}
