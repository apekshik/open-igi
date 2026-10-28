# Weapons, ammo and first-person view models

Readers: `src/formats/weapon.ts` (definitions), `src/game/weapons/data.ts` (loading), `src/game/weapons/viewmodel.ts`
(ATTA, arm rig), `src/game/weapons/sprite.ts` (`.spr`). Field names and the damage rules come from
flawme/igi-reverse-engineering (`reverse/docs/06-weapons`, `reverse/data/weapon_parameters.tsv`); the rest is our own
reading. Confidence: **confirmed** = checked over every file; **reading** = our interpretation, not proven.

## weapons/<NAME>/weapon.qvm (confirmed)

One `DefineWeaponType(...)` call per weapon (24 files). The first 49 values follow the parameter names that
`weapons/weaponconfig.qvm` declares for its `WeaponConfig` task (`Weapon ID`, `Script ID`, ... `Weapon Task Type`);
IGI.exe binds them by position. `weaponconfig.qvm` is the editor's copy of the same table with older values (AK47
32 rounds, spread 5..10 there; 30 rounds, -3.5..3.5 in weapon.qvm): the game uses weapon.qvm.

Differences from the declared list:

- **Missile weapons** (LAW 80 `RPG18`, `APC`, `t80`) insert the missile model (`"110_02_1"`) as a string before the
  weapon task type, so they have one value more.
- **Type-specific values follow** in the same order as that weapon's `TagItemReal32` children in weaponconfig.qvm:

| weapon | trailing values |
|---|---|
| BINOCULARS | min FOV 5, max FOV 90, default FOV 70 (degrees) |
| DRAGUNOV, MP5SD | zoom min FOV (5, 50) |
| M16A2 | M203 muzzle velocity (labelled km/h; 85, used as m/s), explosion radius, activate radius (m) |
| PROXIMITYMINE | time before arming 2 s, countdown 0.5 s, activate radius 1.5 m, explosion radius 3 m |
| MEDIPACK | fraction of max health restored per round (0.01) |

Grenade radii exist only in weaponconfig.qvm (`Grenade - Explosion radius/falloff (meters)`, `damage factor`):
hand grenade 7 / 4 / 1.3, flashbang 10 / 15 / 1.

Units (reading): `Damage Factor` is IGI damage (an AI soldier dies at 1.0, the player at humanplayer.qvm's 3.0;
the hit-zone multiplier scales it: AI head 100, torso 1, limbs 0.5-1). `Effective Range` is metres. `Reload Time`
is 2 s for every weapon; the arm animations are longer (AK47 reload 2.97 s) and set the real pace.
`Rounds/Minute` is the fire rate, `Maximum Rounds/Burst` > 1 means automatic. View-kick values are degrees per shot
(fixed + random, about X = pitch and Z = yaw). The spread pair is read as tenths of a degree (AK47 ±0.35°, Spas 12
2° for its 30 pellets, Dragunov ±0.005°): unproven, chosen because degrees make every gun a shotgun.

## ammo/<NAME>/ammo.qvm (partial)

`DefineAmmoType(index, "AMMO_ID_x", name, description, calibre, f, r, g, b, r, g, b, flag, model, sound)`. The
calibre matches a weapon's `Calibre ID` (762, 919, 10000 = hand grenade, 10001 = mine, ...), so weapons sharing a
calibre share one reserve. `model` is the pickup model (`116_01_1` for 9 mm). The float and the two RGB triples
(250,200,0 / 255,255,0) are not identified (tracer or impact colours?); the flag is 1 for bullets.

## humanplayer/humanplayer.qvm (confirmed)

- `DefineHumanPlayerWeaponCycle(ids...)`: next/previous weapon order.
- `DefineHumanPlayerWeaponCategory(n, ids x n, ...)`: weapon slot keys 1-9 (knife, pistols, SMGs, rifles, shotguns,
  Dragunov, thrown, LAW, medipack); pressing a slot key again cycles within it.
- `DefineHumanPlayerAmmoLimit(AMMO_ID, max, ...)`: carry limits (9 mm 196, 5.56 200, 7.62 128, 12 ga 32, .357 32).
- `DefineHumanPlayerGeneral`: argument 7 is the damage the player dies at (3), 9-25 the player's hit zones.

## Loadouts in objects.qvm

`Gun`, `GunMP5SD`, `GunDRAGUNOV` (`ID`, `Slot`), `Binocular` and `AddAmmo` (`ID`, `Ammo`) appear as child tasks of
`HumanPlayer` (Jones's starting kit; level 1: binoculars, MP5SD, Glock, knife, 49 rounds of 9 mm) and of
`HumanSoldier` (their guns, dropped as a pickup when they die). Each gun starts with a full clip. `GunPickup`
(position, orientation, `ID`) and `AmmoPickup` (+ `Ammo` rounds) lie in the level and use the weapon's gun model or
the ammo's model.

## .mef ATTA chunk (confirmed for weapons)

68-byte records: `char name[16], vec3 position, f32 rotation[9] (row-major), u32 0`. On gun models they place the
sub-models: the magazine and the bolt/slide/cylinder (`100_03_1`, `100_02_1` on the AK47) and the muzzle flash
(`1000_01_1` .. `1013_01_1`, flat star-shaped quads in the XZ plane at the muzzle, Y = barrel). Silenced weapons
have no flash attachment.

## First-person arms: 005_01_1 + common/anims/005.iff (reading, checked visually)

56 bones: 0 root, 1-3 a chain ending in **bone 3 = the gun** (identity rotation in every gun stand pose), 4-26 right
arm and fingers, 27-49 left arm and fingers, 50-52 and 53-55 two chains ending in **bone 52 and bone 55, the moving
gun parts**: in the stand poses their offsets from bone 3 equal the gun's ATTA positions (AK47: bone 52 = magazine
at (6, 833, -607) vs ATTA (-7, 830, -610); bone 55 = bolt). The arm model is in IGI view space (X right, Y forward,
Z up) with the eye at the origin. Dual Uzis put the second gun (`111_05_1`) on bone 52.

Weapon animation ids (`StandAnim`, `MoveAnim`, `FireAnim1-3`, `ReloadAnim`) index 005.iff. **Key times run at 4800
ticks per second** (keys every 160 ticks = 30 fps; the AK47 reload is 14240 ticks = 2.97 s, the stand loop ~2 s).
The Spas 12's reload animation (0.63 s) loads one shell.

## .spr sprite (partial)

`"LOOP"`, u32 9, ..., u32 @40 width, @44 height, @48 format (3 = BGRA8888, 2 = ARGB1555); single-frame pixels start
at byte 124. Multi-frame sprites (`blood1`, 7 frames of 32x32) are version 9 texture arrays: one image record per
frame, read with `decodeTexArray` (src/formats/tex.ts) and played as a flip-book on flesh hits.
`binoculars.spr` (256x256) is the left eyepiece of the binocular frame, `snipersight.spr` (128x96) the top-left
quarter of the scope with its reticle posts.

## Sounds

`common/sounds/sounds.qvm` defines each sound (`DefineSound(name, ID, ..., range m, ..., loop)`): gunshots carry
65 m (Dragunov 100), reloads 3 m. `_loop` fire sounds repeat while an automatic weapon fires and end with their
`_loop_e` tail; single-shot weapons alternate their two samples. Reload sounds come in numbered parts
(`ak47_reload_1..3`), bullet impacts as `bul_<material>_<n>` by the hit surface's game material.

## M203 and casings (reading)

The M16A2 is the only weapon with M203 values. Alternate fire (IGI's AlternateFire action, right mouse here) switches
it to the grenade launcher: `AMMO_ID_M203` (calibre 10002, pickup model `108_05_1`) is fired as a ballistic grenade at
the muzzle velocity and explodes on contact with the explosion radius (3 m). The value is labelled km/h in
weaponconfig.qvm, but every other muzzle velocity in the tables is m/s (M16 950) and 85 m/s matches a real M203. Its
activate radius (1 m) is not used yet. `Casing Model` (`113_01_1` for 5.56) is ejected to the right of the player's
gun on every shot.
