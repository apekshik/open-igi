# Mission logic and text

How IGI's missions are scripted, as implemented in `src/game/mission/` and `src/formats/strings.ts`.

## Language text (`language/<lang>/*.res`)

`missions.res`, `objectives.res`, `messages.res`, `computer.res`, `menusystem.res` and `movies.res` are ILFF `IRES`
archives, but not NAME/BODY file pairs: every entry is a `NAME` chunk (the key, NUL-terminated) followed by a `CSTR`
chunk (Latin-1 text, NUL-terminated).

```
NAME "M1_OBJ1"                          CSTR "Steal the truck near the main entrance."
NAME "LOCAL:english/Mission 1 Name"     CSTR "Trainyard"
```

`missions.res` and `menusystem.res` prefix keys with `LOCAL:<language>/` and end with a `PATH` chunk named after the
prefix that lists all keys joined by `;`. Scripts use keys without the prefix, so `readStrings()` strips it. The key
spaces of the six files do not collide; we merge them.

| keys | file | use |
|---|---|---|
| `Mission N Name`, `Mission N Desc` | missions | mission select (referenced by `DefineMission`) |
| `MN_OBJk`, `OBJ_k_COMPLETE/FAILED/INCOMPLETE` | objectives | map-computer objectives |
| `MN_CUT_kk` | messages | intro cutscene subtitles (the briefing dialogue) |
| `MN_OUT_kk` | messages | outro subtitles |
| `MN_MSG_k`, `MISSION_COMPLETE/FAILED`, `ALARMON_*`, `CAMERASOFFLINE_*` | messages | in-game status messages |
| `*_TITLE`, `*_INFO*` | messages | map-computer building info |

## mission.qvm

Only `DefineMission(number, nameKey, descKey, "", nextMission, levelDir, commonDir, levelDir, "location0", "levelN",
"missionN.spr")`. All gameplay logic is in objects.qvm.

## objects.qvm logic tasks

Logic tasks carry QSC expressions as `VarString` parameters, e.g. `"EditVariable_105.nValue == 0 &&
AreaActivate_200.nActive"`. An expression names other tasks as `<Type>_<id>.<field>`, or `this.<field>`. The engine
compiles them at load; we parse them into the same AST as `.qvm` code (`script.ts`) and evaluate them every logic tick.

- **Tick rate**: `GAME_FREQUENCY` is 30 (IGI.exe registers the constant with `push 1Eh; push "GAME_FREQUENCY"`), so
  `nTick`-style fields count 1/30 s ticks. Scripts compare them with `==`, so logic runs at a fixed 30 Hz.
- Other constants: `TRUE` 1, `FALSE` 0, `MATH_PI`, `WORLD_METER` (4096). Bare text keys (`M1_MSG_4`) and
  `CRITERIA_*` evaluate to their own name.
- Two retail strings contain stray backticks (level5 `LevelTimer_95.On`, level10 `ConditionalContainer_354`); we
  skip them. One (level6 `Door_1115` close expression, `"nDoorOpenTicks > * GAME_FREQUENCY"`) does not parse and
  is treated as false.
- Natives used by the expressions: `LevelFlow_GetBreakCutSceneKey()`, `MenuManager_SetEnabled(b)`,
  `Game_DisableMusic()`, `Game_EnableMusic()`, `Game_CutsceneDelete()`, `StatusMessageScreen_ClearMessages()`.
  `Run at start/stop` strings chain them with `&&`, so they return 1.

### Containers

`ConditionalContainer(Condition, Run at start, Run at stop)` gates its subtree: children exist only while it runs
(`isRun`). Every level is structured as *intro cutscene container* → *gameplay container* (holding `HumanPlayer` and
status messages; its condition is "neither cutscene container runs") → *outro container* (started by the final
objective area). The player is frozen and the camera scripted while its `HumanPlayer` task is outside a running
container. Area tests keep the player's last answer while it does not exist, because outro conditions test the very
`AreaActivate` that started them.

Static models (`EditRigidObj`, `Building`) inside containers follow the same rule (`Placement.gates`, tested with
`gatesOpen()` in `src/game/mission/gates.ts`): the world system draws them and physics collides with them only while
every enclosing container runs. Levels 3 and 5 put an invisible `colbox` across the elevator doorway inside a
container on `Elevator_N.isMoving`; level 2 swaps each SAM site for its wreck and shows the planted C4 that way.
AI scripts read task fields (`EditVariable_752.nValue`) through the same evaluator.

### Task types and fields

Parameters are named from each script's `Task_DeclareParameters`; `ObjectPos`/`Real32x3`/`RGB` take three values,
`Real32x9` (orientation) is stored as three Euler angles, `PushButton` none.

| type | parameters used | fields |
|---|---|---|
| EditVariable | Initial value, Add, Sub (+1/−1 per tick while true) | `nValue` |
| AreaActivate | Position, Orientation, Dimensions (full box size, world units), Criteria `CRITERIA_HUMAN0` (player side), `CRITERIA_HUMAN1` (enemies), `CRITERIA_VEHICLE` | `nActive` (count inside) |
| LevelTimer | On, Reset, Initial run | `isRun`, `nTick` |
| StatusMessage | Send (rising edge), Text (key), Sound, Is send once, Duration | `isSendt`, `nTickSendt` (ticks since sent), `nTicksSinceFinishedDisplay` |
| LevelFlow | Complete, Failed, Max level play time (s) | `nTick`, `isFailed` |
| DefineComputerObjective | Objectives Valid, 6 × (Text Resource, Link To Position, Complete, Failed) | — |
| CutScene | Run, Reset, Time scale; EditCamera children (Position, Alpha, Beta, Gamma, FOV, Duration, Link/Target task, Smooth to next) | `isRun`, `isFinished`, `nTick` |
| AnimTask | Run | `isRun`, `nTick` |
| Door | Position start, stop X/Y (slide in metres, local axes), slider (initial opening), Max angle (swing, degrees), Open time, Pickable, Pick lock time, Locked/Open/Close expressions, sounds | `isOpen`, `isClosed`, `isLocked`, `isPicked`, `nDoorOpenTicks`, `isLastOpen` |
| Switch | On (enabled), Initial on (lit model), models, Destructable | `isPressed` (latches), `isLastPressed` (one tick) |
| Terminal | Model, explosion block, On Expression, Hack Time | `isHacked`, `isHackedThisTick`, `isExploded` |
| AlarmControl | Terminal fields + Trigger Expression, Alarm Expression | `isTrigger`, `isAlarm` |
| SCameraControl | Terminal fields + Detection Expression | `isOn`, `isDetection` |
| SCamera | holder/camera models and angles, sweep right/left/speed/delay, view cone, On Expression | `isDetection`, `isExploded` |
| ExplodeObject (and the same block in Terminal, Generator, Siren, Radio, GenericTBA…) | models, Damage scale, Explosion radius/falloff/damage scale/delay, Explosion expression | `isExploded` |
| GenericPickup | Model | `isPickedUp` |
| GenericTBA / PlaceExplosiveTBA | On Expression, Activate Time, Activate radius | `isFinished` |
| Cabinet | Search Time | `isSearched` |
| Generator | On expression | `isOn`, `isExploded` |
| Elevator | SplineObj (waypoints = floors), Max speed, Can start, Wanted floor 0..9, Floor up/down | `vFloor`, `isMoving` |
| HumanSoldier, HumanPlayer, Car, Heli, GunPickup | (other systems' entities, by task id) | `isDead`, `isExploded`, `isPickedUp` |
| HumanAI | (child of a soldier) | `isDetection` (the soldier is alert/in combat) |

- **Door** open/close expressions trigger on their rising edge. Elevator doors open on `Elevator_N.vFloor == k`, which
  stays true while the car waits; as a level it would reopen the doors the tick a call button closed them, so the
  car's `Can start` (its doors closed) never held.
- **Elevator** call buttons pulse for one tick and close the doors at the same time, so a wanted floor is remembered
  until `Can start` holds.
- **DefineComputerObjective**: only the last valid one is listed. Level 3 is the only level with several; its second
  and third sets are both valid after the hack and both list `M3_OBJ3`.

Alarm logic is entirely scripted: an `AlarmControl`'s trigger watches alarm pads (`Switch.isLastPressed`) and camera
detection, an `EditVariable` latches the alarm, and `isAlarm` reads it back. When an AI soldier raises the alarm
(`alarm` event) we press the nearest pad, so the level's own consequences (messages, doors, lights, guard spawns)
follow.

### Cutscene cameras

`EditCamera` keys run back to back for their `Duration`. `Gamma` is the heading (same convention as ours, 0 = +Y),
`Alpha` the pitch measured from straight down (−π/2 = horizon), `Beta` the roll. `FOV` 1 is taken as 90° horizontal.
A `Target task ID` makes the key look at that task. `Smooth to next` interpolates to the next key.
