# Player (HumanPlayer) data and movement rules

What `src/game/player/` reads from the install and which engine rules it reproduces. Values marked *exe* were
recovered from `IGI.exe` by community research (see THIRD_PARTY.md: flawme/igi-reverse-engineering and
Haseebraza12/reimagine-igi); values marked *data* we read from the files ourselves.

## Spawn: the `HumanPlayer` task (objects.qvm)

`Task_DeclareParameters("HumanPlayer", "Position", "ObjectPos", "Gamma", "Angle", "Model", "String16", "Team", "Int32")`.
`ObjectPos` expands to three numbers, so a task reads `Task_New(0, "HumanPlayer", name, x, y, z, gamma, "000_01_1", team, ...)`.
Gamma is the heading in radians with the same convention as `coords.direction` (0 faces +Y, counter-clockwise;
forward = (-sin g, cos g)). The task id is 0 in every level. The position is near the pelvis; the controller drops the
feet onto the ground below it.

## `humanplayer/humanplayer.qvm`: `DefineHumanPlayerGeneral` (43 numbers)

| arg | shipped | meaning | engine unit |
|---|---|---|---|
| 0 | 1.75 | multiplier on animation root motion: the player's speed is the clip's root speed x1.75 (*exe*) | - |
| 1 | 17.5 | jump horizontal speed along the current movement direction (*exe*) | km/h |
| 2 | 27 | jump vertical speed (*exe*) | km/h |
| 3 | 0.5 | air control: move keys add this much speed per 30 Hz tick while airborne (*exe*) | km/h per tick |
| 4 | 0.85 | lean: sideways eye offset (*exe*) | m |
| 5 | 0.85 | lean: upward eye offset while crouched and pressing forward (peek over cover) (*exe*) | m |
| 6 | 0.25 | lean time; truncated to whole ticks (7) (*exe*) | s |
| 7 | 3.0 | damage the player can take before dying (AI soldiers: 1.0) (*exe*) | damage |
| 8 | 0.5 | electric-fence shock damage (*exe*; not used yet) | damage |
| 9..25 | 0.5, 0.75, 1 x4, 1 x5 | damage multiplier per hit zone 0..16 (*exe*) | - |
| 26..42 | ... 100000 x2 | a second zone table with no known reader (*exe*) | - |

Hit zones: four limbs x (distal 0.5, middle 0.75, proximal 1), 12 torso, 13 torso front, 14 torso back, 15 head front,
16 head. The player's head multiplier is 1 (soldiers' is 100). The physics service reports coarse parts, mapped as
head -> 16, torso -> 12, legs/arms -> middle limb (0.75), foot/hand -> distal (0.5); `"zone N"` selects a zone directly.

## Engine constants (*exe*)

- 4096 units per metre, logic at 30 ticks per second.
- Gravity while jumping/falling: 84.74 units per tick² = 18.62 m/s². A standing jump peaks at 1.64 m and lands after
  ~26 ticks.
- Fall damage on landing at v m/s: `max(0, v - 14) / 13 x maxDamage` (hurts from a ~5.3 m drop, kills from ~19.6 m).
  Sounds `player_fall_1/2/3` for under 10 %, under 20 %, otherwise; the ground material's landing sound; a camera dip
  of `min(1, v/8) x 0.25 m`; a ground-impact noise of 5 m (10 m when it hurt).
- Ground snap 0.5 m while grounded. Collision probes reach 1.8 m standing, 1.3 m crouched; standing up is refused
  under a lower ceiling.
- Bullet hits push the player 5 km/h along the shot's horizontal direction, decaying x0.9 per tick.
- No jump while crouched; crouch is held, not toggled; run is the default and walking is a mode.
- Eye: the pelvis (animated root) + 0.69 m standing / + 0.35 m crouched. Crouched idle pelvis 0.43 m -> eye 0.78 m;
  standing 0.95 m -> 1.64 m. Following the pelvis gives IGI's stance blend and its head bob.
- View: horizontal half-angle tan = tan(30°) at 4:3, i.e. a 46.8° vertical FOV.
- Difficulty scales damage to the player by 0.75 / 1 / 1.25 (easy / normal / hard); normal is assumed.

## Animations (`common/anims/000.iff`, skeleton of `000_01_1`) (*data*)

Clip time runs at 4800 ticks per second. Looping clips have flag bit 31. Movement clips per state (the exe's table):

| gait | fwd | fwd-right | fwd-left | back | back-right | back-left | right | left | idle |
|---|---|---|---|---|---|---|---|---|---|
| run | 4 | 37 | 35 | 64 | 70 | 68 | 11 | 10 | 2 |
| walk | 57 | 74 | 72 | 75 | 77 | 76 | 81 | 80 | 2 |
| crouch | 17 | 41 | 39 | 27 | 49 | 47 | 29 | 28 | 19 |

Jump 25 (played at 0.4x), fall 2, ladder climb 168, deaths 201/202 (head 204). Speed = root displacement over one
cycle x1.75: run forward 5.88 m/s, run strafe/back ~4.8, walk forward 2.18, crouch 2.79.

**Footstep events.** Each clip's `BOED` chunk holds 24-byte records `{u32 type, u32 bone, f32 time, vec3 offset}`.
Type 1010 is a footstep; the bone is the landing foot (22 / 27). Run and crouch-move clips have two per cycle; the walk
forward/strafe clips and the idle clips have none, so walking is silent.

## `material/material.qvm` (*data*)

`SetActiveMaterial(i); DefineGameMaterial(name, ?, ?, ?, ?, footstepRange (m), walk1..walk6, land, rain, bullet
sounds..., ...)`. The footstep range is how far AI hears a step: 1 m on most surfaces, 10 m on gravel, 0 on
textiles, rugs, snow and glass. A crouched player raises no footstep noise (*exe*). Sound names resolve to
`common/sounds/<name>.wav` inside `common/sounds/sounds.res`; `"Walk0"` means none. Player sounds used:
`walk_<surface>_1..6`, `land_ground_1..5`, `jump_1`, `player_fall_1..3`, `player_hit_1..4`, `player_death_1..3`.

## open-igi additions

- Prone (key Z): IGI 1 has no prone. Eye 0.3 m, 0.6 m/s.
- Lean on Q/E with a 10° camera roll (IGI leans with Peek + strafe and only shifts the eye). The eye stops 0.25 m
  short of walls. As in IGI the player does not move while leaning.
- Ladders: attach when walking into a surface whose physics material matches `ladder` (`MetalLadder`); climb at
  1.4 m/s. No level places ladder tasks; they are part of building collision meshes.
