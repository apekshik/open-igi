export interface WeaponState {
  /** Weapon id as the game names it (e.g. "WEAPON_ID_AK47"). */
  id: string;
  name: string;
  clip: number;
  clipSize: number;
  /** Rounds in reserve, not counting the clip. */
  reserve: number;
}

export interface WeaponsService {
  /** The player's weapon in hand, or null (unarmed / binoculars). */
  current(): WeaponState | null;
  /** The player's inventory in slot order. */
  inventory(): WeaponState[];
  /** Give an entity a weapon (pickups, level start loadout). */
  give(entityId: number, weaponId: string, rounds: number): void;
}
