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
`AIAction_Activate(alarm)` (run to the alarm pad) and/or `AIAction_Combat`. Level scripts may pick the alarm
switch (`SetAlarmTriggerID`), the timing (`SetAlarmAccess`, default `AIALARMACCESS_BEFORECOMBAT` when unset), a fixed
death clip (`SetDeathAnimation(85)`), a stationary gun to man (`SetGunnerID`) and scripted fire
(`AIAction_FireAtTask(task, rounds, seconds, ...)`; argument meanings are our reading). Clip ids in the scripts (`PlayAnimation(36)` after a near miss,
`37` when the noise is behind, `39` stunned by a flashbang) are soldier-skeleton (001.iff) ids.

## common/ai/settings.qvm

`HumanAIConfigItem` tasks, one per AI type and difficulty (`GD_1` easy, `GD_2` normal = config.qvm's shipped `GOGameDiff`,
`GD_3` hard; `AiService.difficulty`, starting from `?difficulty=1..3|easy|normal|hard`), with
32 named values: damage scale, recoil threshold, combat initial/repeat movement delay, targeting timeout (s), tracking
distance (m), lie-down minimum distance (m), evasive action and roll/lie-down probabilities, hit probability at minimum
and maximum range, max rounds per burst, aim precision, minimum/random clip fraction per burst, minimum/random delay
between bursts and between shots, grenade probabilities, distances and timings, close-combat hit probability and
damage. `src/game/ai/level.ts` lists them in order. The difficulty picks the row and nothing else that we know of
(flawme's 15-configuration confirms the three constants but not their effect). Normal (GD_2) for the common types:

| type | damage scale | hit near / far | aim precision | rounds per burst | burst delay s | grenade p |
|---|---|---|---|---|---|---|
| PATROL_AK | 0.5 | 1 / 0.3 | 0.8 | 6-15 of 30 | 0.5-1 | 0.33 |
| GUARD_AK | 0.5 | 1 / 0.3 | 0.6 | 24-30 of 30 | 0.5-1 | 0.33 |
| SPETNAZ_*_AK | 1 | 1 / 0.7 | 0.7 | 3-12 of 30 | 0.5-1 | 0.33 |
| SNIPER | 0.5 | 1 / 0.5 | 0.6 | 1-3 of 10 | 1.5-2 | 0.33 |
| GUNNER | 0.5 | 1 / 0.3 | 0.6 | 50 | 1-2 | 0.33 |

How we use them (`soldier.ts`, `CombatAction`):

- **Hit chance per round** = lerp(hit near, hit far, d / view range) x (precision + (1 - precision) x max(0, 1 - d / 10 m))
  x settle (0.4 rising to 1 over 3 s of continuous sight) x target (crouched 0.75, prone 0.5; walking 0.75, running
  0.55). The data gives the two probabilities and the precision; how IGI.exe combines them is our reading. A hit is
  aimed at the chest (15 % head, or the head when the chest is behind cover), a miss 0.5-1.5 m beside the target.
- **Reaction** before the first burst = the burst delay; bursts = clip x (min + random clip fraction), capped by max
  rounds; shots paced by max(weapon rate, min + random shot delay).
- **Damage scale** multiplies the weapon's Damage Factor (AK47 0.3 -> 0.15 per hit at GD_2; Jones dies at 3.0).
  Shotguns: we read the Spas 12's 0.25 as the whole shell's damage, shared by its 30 pellets (read per pellet, one
  guard shell did up to 7.5 at 10 m; the weapons system still applies it per pellet to the player's own shots).
- **Recoil threshold**: a hit at least this strong stops the soldier's burst for 0.5-0.8 s.
- **Grenades**: soldiers carrying WEAPON_ID_GRENADE/FLASHBANG (one per Gun task; 51 and 23 in the 14 levels) roll the
  grenade probability before a burst (and the "when reload" one once per reload) while the target is within the
  min/max distance, with a 4 s cooldown. Clip 70 is the throw (hand swings up to 1.6 m and forward), released at 55 %.
  Flight time = min + random fly time, stretched so the horizontal speed stays under 16 m/s; fuse = flight + min +
  random explode time.
- **Close combat** within 1.4 m: rifle butt, close-combat hit probability and damage, every 1.2 s.
- **Styles**, from IGI.exe's combat state names ("Combat - Kneel/Liedown/RePosition/Follow/LookForTarget", "Guard
  Combat - Stand", "RPG Combat - Stand/Kneel", "Gunner Combat - Stand"): patrol types move (follow 10 m at a time
  beyond the tracking distance, evasive rolls, crouch, lie down beyond the lie-down distance, reposition to a node with
  a clear line of fire), firing a burst between moves; guard types and snipers hold their post; RPG soldiers (no
  retail level places one) stand or kneel and fire LAW rockets at the target's feet; gunners man a stationary gun.

## AIACTIONFLAG_PUSHABLE

Scripts pass it to AIAction_Combat, AIAction_Activate, AIAction_Patrol (level 4's Priboi escort path) and others. We
read it as "a later event may push this action down": the new actions run on top and the pushed one resumes when they
end (its walk is re-planned). Actions queued without it are replaced. So Priboi runs from gunfire for 15 s and then
carries on along his path, and soldiers go back to a pushable patrol after a fight. Unarmed characters that are not
civilians take cover (crouch 4-6 s) instead of fighting.

A walking character that gains less than 0.5 m on its next route point over 2 s moves on to the point after it. The
per-frame stuck rule missed characters jittering in a corner (sliding along one wall, pushed back by another): Mission
10's Priboi froze by the warehouse roof on his way back along "Priboi legs it1".

## Stationary guns (StationaryGun tasks)

Position, Orientation (3 angles, the third the heading), Holder model (123_02_1), Weapon ID (WEAPON_ID_M2HB), Max up
angle, Max down angle, Max sideways angle (degrees), Ammo (-1 = unlimited). Level 8 has six, manned by AITYPE_GUNNER
soldiers through `AIFunction_SetGunnerID`. The position sits on top of a post or sandbag wall about 1.3 m above the
floor; we draw the holder there and the gun (123_01_1, barrel along +Y, 1.24 m) on top, traverse it within the limits
at 1.6 rad/s and stand the gunner 0.95 m behind it on the floor. gunner.qvm answers COMBAT and ALARMON with
`AIAction_Activate(gunner id)` while `AIFunction_GetGunnerStatus()` is false; arriving mounts the gun, after which
combat fires the gun's weapon (M2HB: Damage Factor 1, so 0.5 per hit at GD_2). Walking away dismounts.
`AIStationaryGunHolder` (level 14's automatic sentry guns) is not done.

## Doors, ladders, lighting

Graph nodes carry `NODECRITERIA_DOOR` but doors are separate Door tasks (most with task id -1). A walking soldier
casts a ray 1.5 m along its route every 0.25 s; when it meets a door entity that the mission system reports closed and
unlocked (`MissionService.door/openDoor`) it opens it and waits up to 2 s for it to swing open; locked doors stay shut.
A door the player works within 10 m of a soldier is AIEVENT_DOOR (range chosen). No AI graph has ladder nodes (the
criteria are only DOOR, STAIR and VIEW) and no script does more with ladders than hear AIEVENT_LADDER, so soldiers do
not climb ladders. Nothing in the scripts, settings or IGI.exe's AI strings refers to light, so detection ignores it.

## Containers, cutscenes and passengers

A character that entered play because its ConditionalContainers run is removed (AIEVENT_DELETE first; body, entity
and gun go) when one of them stops, and spawns afresh if it runs again. Cutscene and vehicle characters are spawned
only through `AiService.spawn(taskId, { passenger: { anchor } })`: passive (no senses, no fighting) and carried by the
anchor every frame. No system exposes Heli, Car or Train transforms yet, so nothing calls it.

## Spacing

A soldier whose route ends where a comrade stands or is heading stops 1.2-2 m beside it instead, and walking soldiers
are pushed apart within 0.9 m (chosen; QA saw guards stacking on one spot in level 12).

## Friendly fire

Nothing in the data says whether soldiers' bullets hurt their own side. In play-testing they killed each other in
crossfire within seconds, so before every round a soldier checks for a living comrade within 1 m of the line to the
aim point (or 3 m beyond it) and holds the burst (patrols then reposition), and soldiers' bullets do not damage their
own team; grenades, rockets and other explosions still do. Before each burst (and every 5 rounds) the line of fire
from the muzzle is checked too: sight passes glass and chain-link fences but bullets stop there, so a soldier whose
shot would hit a wall, fence, glass or door holds fire instead of emptying clips into it.

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

- Hearing (data): each weapon's "AI Detection Event Range" names `HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE` or
  `HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE`; IGI.exe registers them for the scripts as 0x1E000 and 0x1000 world
  units, i.e. 30 m and 1 m (the MP5SD, knife and thrown grenades use the silenced range). Comrades' shots are heard
  too, which is how a fight draws the guards around it.
- Sight (data): 40 m, 50 m while the alarm is on or fighting, half-angle 45 degrees, vertical 50 (snipers 100 m and
  15 degrees), from the type scripts.
- Detection time (chosen; nothing in the data): seconds to notice = (0.4 + 2.6 (d / range)^1.5), x1.8 crouched, x3
  prone, x0.6 running, x1.3 still, x0.3 within 4 m, /1.5 while the alarm is on; peripheral vision to 110 degrees within
  8 m at 30 % rate. Measured on level 1 standing still in view: about 0.4 s at 10 m, 0.6 s at 20 m, 0.7-1 s at 30 m;
  crouched at 20 m about 1.1 s.
- A bullet passing within 2 m is a near miss (`AIEVENT_GUNSHOTMISS`).
- A soldier entering combat alerts (`AIEVENT_ALERT`) comrades within 15 m, or 35 m with line of sight, once per wave;
  `AIFunction_SendResponse` answers the alerting comrade with `AIEVENT_ALERT_RESPONSE`.
