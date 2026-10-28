# AI: characters, scripts, navigation graphs, patrols

Code: `src/formats/graph.ts` (graph files), `src/game/ai/` (level data, scripts, navigation, bodies, behaviour).

## Characters in objects.qvm

Every AI character is a `HumanSoldier` task (parameters from the level's own `Task_DeclareParameters`):

| param | example | meaning |
|---|---|---|
| Position (ObjectPos) | 24508498, -55937160, 174414816 | feet, IGI units; 9 of level 1's soldiers float 0.2-5.5 m up, so we stand them on the floor below |
| Gamma | 0 | heading about Z |
| Model | `"003_01_1"` | type 1 (skinned) model |
| Team | 1 | 0 = Jones's side |
| Bone Heirachy | 1 | skeleton/animation file `common/anims/001.iff` |
| Stand Animation | -1 / 19 / 61 | clip played while idle (-1 = default) |

Its children: `Gun`/`GunMP5SD`/`GunDRAGUNOV` (`"WEAPON_ID_AK47"`, slot), one `HumanAI` (`"AITYPE_PATROL_AK"`, Graph ID)
and any number of `PatrolPath` tasks, each a list of `PatrolPathCommand(Command, Command Parameter)`.

Where a character sits in the tree decides when it exists. Characters inside a `CutScene`, `Heli`, `Car`, `Train` or
`AnimTask`, or inside a `ConditionalContainer` whose name says cutscene ("Intro cutscene", level 3's "Intro cutscnee")
belong to cutscenes and vehicles and are only spawned on request (`AiService.spawn`). The rest wait for every
enclosing `ConditionalContainer` to run (`ConditionalContainer_<id>.isRun`, asked through the mission system): level
1's guards live in "Main character and status messages", which runs once the intro cutscene is over. A `HumanSoldier`
under a `GuardGenerator` ("Generate guards" condition, "Max spawns") is a template: copies spawn while the condition
holds, one at a time, up to the maximum (`AiService.generatorSpawns` reports the count).

## PatrolPathCommand ids

The level editor stored a note with each command (the task's name), which gives the meaning of every id used in the
14 levels:

| id | note | parameter |
|---|---|---|
| 0 | "Plays predefined animation N" | clip id |
| 1 | "Delays the script execution for N ticks" | ticks at GAME_FREQUENCY (30/s) |
| 2 | "Walks to node id N" | graph node |
| 3 | "Runs to node id N" | graph node |
| 4 | "Crouch. Takes no parameters" | - |
| 5 | "Looks at node id N" | graph node (often a NODECRITERIA_VIEW node) |
| 6 | "End script, only runs commands after this one" | - (we repeat the commands after it forever) |
| 7 | "Quit script, stops script" | - |
| 8 | "Set travel speed to N km/h" | km/h, 0 = normal |

A patrol that quits leaves the soldier with nothing to do; its script gets `AIEVENT_IDLE` and usually starts the same
patrol again, which is how walking patrols loop and posted guards stay at their post.

## AI scripts

`missions/location0/<level>/ai/<HumanAI id>.qvm` per character and `common/ai/<type>.qvm` per type (`guard`, `patrol`,
`sniper`, `gunner`, `rpg`, `civilian`, `anya`, `ekk`, `priboi`; `*_GUARD_*` types use guard.qvm, `*_PATROL_*` patrol.qvm).
Both decode with `decodeQvmScript` to `if/else` chains on `AIFunction_GetCurrentEventType() == AIEVENT_*`. A level
script typically handles `AIEVENT_CREATE` (`AIFunction_SetAlarmControlID(98)`), `AIEVENT_IDLE`
(`AIAction_Patrol(2405, 0, AIACTIONFLAG_NONE)`) and `AIEVENT_ALARMON` (`AIAction_Patrol(2605, ...)`, the run to an
alarm station) and passes everything else to `AIFunction_DefaultHandler()`, the type script. The type script's CREATE
handler ranks the events with `AIFunction_SetEventPriority` (first call = highest) and sets the senses:
`SetViewLength(40)` metres, `SetAlarmViewLength(50)` (while the alarm is on), `SetViewGamma(45)` (we read it as the
horizontal half-angle) and `SetViewAlpha(50)` (vertical); snipers see 100 m in a 15 degree cone.

How we run them (`src/game/ai/script.ts`, `soldier.ts`): an event runs the scripts unless the actions queued by a
higher-ranked event are still running; `AIAction_SetCombat` posts `AIEVENT_COMBAT`, whose handler queues
`AIAction_Activate(alarm)` (run to the alarm pad) and/or `AIAction_Combat`. `AIFunction_GetAlarmAccess` is never set by
any script; we answer `AIALARMACCESS_BEFORECOMBAT`. Clip ids in the scripts (`PlayAnimation(36)` after a near miss,
`37` when the noise is behind, `39` stunned by a flashbang) are soldier-skeleton (001.iff) ids.

## common/ai/settings.qvm

`HumanAIConfigItem` tasks, one per AI type and difficulty (`GD_1`..`GD_3`; we use `GD_2` unless `?difficulty=N`), with
32 named values: damage scale, recoil threshold, combat initial/repeat movement delay, targeting timeout (s), tracking
distance (m), lie-down minimum distance (m), evasive action and roll/lie-down probabilities, hit probability at minimum
and maximum range, max rounds per burst, aim precision, minimum/random clip fraction per burst, minimum/random delay
between bursts and between shots, grenade probabilities, distances and timings, close-combat hit probability and
damage. `src/game/ai/level.ts` lists them in order.

## Soldier clips (common/anims/001.iff)

Identified from root motion and bone positions (pelvis height 0.97 m standing, 0.54 m crouched, 0.11 m prone):

| clip | use |
|---|---|
| 2 | stand idle (rifle at the ready); 14 relaxed idle |
| 4 | walk (1.43 m per 1.1 s cycle) |
| 3 | run (2.45 m per 0.7 s); 34 sprint (panic) |
| 5 / 6 | stand aim / fire loop |
| 7 / 19 | stand to crouch / crouch to stand; 18 crouched |
| 8 / 9 | crouch aim / fire loop |
| 12 / 13 | dive to prone / get up; 16 prone, 17 prone fire, 20 crouch to prone |
| 10 / 11, 33 / 32 | evasive rolls left / right from standing, from crouching |
| 22, 23, 28, 29, 30 | deaths standing (22/23 fall forward, 28/29 backward, 30 slow); 24 crouched; 25 prone |
| 36, 37, 39 | look around, turn to a noise behind, stunned (script ids) |
| 91 | hands up |

Bones 20-21-22 branch off the spine and carry the gun: bone 22 sits in the right hand, and the weapon's model
(`DefineWeaponType`'s model, e.g. `100_01_1`) hangs on it unrotated.

## Navigation graphs (graphs/graph<id>.dat)

One per `AIGraph` task (the task id is the file number); node positions are relative to the task's "Graph position".
The files are a stream of one-byte-tagged tokens: `0x00 u8 type` (field type marker), `0x04 u32` (field key),
`0x05 i32`, `0x06 f32`, `0x08 3 x f64`, `0x09 u8 n, char[n]` (string with its NUL).

Keyed layout (all levels but level 8): `u32 0xFFEEDDCC`, then keyed fields. The keys are `IGI.exe`'s hash of the
field name (`h += upper(c) * m; m = (m + 0x13d) & 0xffff`, m starting at 1): `nMaxNodes` (route table dimension),
`RouteTable` (marker `0x0a`, `0x05` byte size, then `dim x dim` cells of `{u32 nextHop, f32 distance}`, indexed
[destination][source]), then for each node `nNodeID`, `tNodePosition`, `vNodeGamma`, `vNodeRadius`, `nNodeMaterial`,
`nNodeCriteria` (`"NODECRITERIA_DOOR"`, `"NODECRITERIA_STAIR"`, `"NODECRITERIA_VIEW"` or ""), then for each link
`nLinkID1`, `nLinkID2`, `eLinkType` (always 1).

Positional layout (level 8's seven files): `i32 nodeCount, i32 dim, i32 linkCount`; per node `id, position, gamma,
radius`, one more f32 in most files, `material, criteria`, then two lists of id pairs (each a count then the pairs;
meaning unknown); per link `id1, id2, type`; then a route table the game does not read.

All 300 graph files parse; every link refers to existing nodes. `NODECRITERIA_VIEW` nodes are unlinked look-at targets.
We route with A* over the links (`src/game/ai/nav.ts`), which finds the same shortest paths as the route table and
works between arbitrary positions; walking goes through `physics.move` so floors and walls hold the soldier.

## Choices where the data is silent

- Detection is gradual: seconds to notice = (0.4 + 2.6 (d / range)^1.5), x1.8 crouched, x3 prone, x0.6 running, x1.3
  still, x0.3 within 4 m, faster while the alarm is on; peripheral vision to 110 degrees within 8 m at 30 % rate.
  Lighting is not modelled.
- Gunshot hearing 80 m (silenced 8 m); a bullet passing within 2 m is a near miss (`AIEVENT_GUNSHOTMISS`).
- Hit chance = lerp(near, far, d / (1.25 x alarm view length)) x a settle factor that grows from 0.35 to 1 over 3 s of
  continuous sight, x0.8 against a crouched target, x0.6 prone. Misses are aimed 0.5-1.5 m beside the target.
- A soldier entering combat alerts (`AIEVENT_ALERT`) comrades within 15 m, or 35 m with line of sight.
