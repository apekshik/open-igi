# Moving things: doors, elevators, vehicles, trains, ladders

Notes from the dynamic-objects workstream. Runtime: `src/game/physics/` (dynamic colliders), `src/game/mission/`
(`logic.ts` tasks, `vehicles.ts` motion, `objects.ts` drawing), `src/game/world/splines.ts` (trains). Confidence as
in `../FORMATS.md`: **confirmed** = checked over all 14 levels; **inferred** = our reading, not proven against the
engine.

## Dynamic colliders (open-igi design)

`PhysicsService.addDynamic(model, matrix, { entityId })` registers a model's `.mef` collision sets (see
`collision.md`) as a moving collider; its owner calls `setMatrix` (a rigid matrix in `game.world`'s frame) every frame.
Each collider keeps its triangles in model space in its own BVH; rays, sight, `ground` and `move` transform into the
collider's frame, so a moving collider costs no rebuild. Hit flags are the static world's (hit set for rays and sight,
human hull + thin real shape for movement).

- `RayHit.collider` / `entityId`: rays report the collider and its entity (doors, vehicles), so bullets damage the
  object and draw surface impacts (weapons only bleed `player`/`soldier`/`civilian` entities).
- A ray that starts inside a collider's bounds ignores that collider (a guard's muzzle beside a door, a gunner in a
  vehicle).
- `GroundHit.platform`: the collider stood on.
- **Carrying** (physics `lateUpdate`, after every system moved its objects): a character whose feet rest on a
  collider's walkable surface at its previous pose, above the static ground there, moves with the collider
  (`matrix × inverse(previous)`). Elevator cars, train roofs and vehicles carry the player and soldiers; door hulls
  that reach the floor do not.
- **Pushing**: a collider that moves into a character pushes the capsule out horizontally (away from the surface, or
  along the collider's motion).
- `carve(matrix)`: some buildings carry a closed door leaf in their own hit set (`400_02_1`, `418_01_1`: Wood faces in
  the doorway portal). A Door object removes the static triangles inside its closed-pose bounds when it registers.

Cost on Mission 1 (68 colliders: doors, switches, terminals, cameras, vehicles, train cars), 3000 random queries:
raycast 3.8 → 4.8 µs, move 2.6 → 2.9 µs, line of sight 2.8 → 3.3 µs; carrying under 0.01 ms per frame.

## Doors (confirmed fields, inferred behaviour)

`Door(Position start, Position stop X/Y (m), Position slider, Orientation, Model, Max angle, Open time, Pickable,
Pick lock time, Locked/Open door/Close door expressions, sounds)`. Most retail doors slide (`stop X` = -1 m, `Max angle`
0). The open and close expressions act on their rising edge: elevator doors open on `Elevator_51.vFloor == 0`, which
stays true while the car waits, and a call button's close pulse must still shut them.

AI soldiers open closed, unlocked doors they walk into (the AI graphs mark doorways with `NODECRITERIA_DOOR` nodes and
`AIEVENT_DOOR` reaches the scripts via the door sound); locked doors stay shut to them.

A door closed with the use key onto someone standing in its way (player or soldier overlapping the leaf) opens again:
the leaf used to push Jones into its hull, where he could not walk out (Mission 10, warehouse door 256). Closes from a
`Close door expression` (elevator doors) are not undone, or a guard beside the lobby doors would keep a car waiting.

## Elevators

The car (`Model`) rides its `SplineObj`'s waypoints (floors). Calls are one-tick pulses (`Switch.isLastPressed`) that
also close the doors, while `Can start` waits for the doors; the request is latched until it can start. Cars are
dynamic colliders and carry whoever stands in them (Missions 3, 5, 12 checked).

## Recorded vehicle input: `AnimTask.AnimData` (confirmed format, inferred meaning)

`Car`, `Heli`, `Plane` and `Train` tasks move under rigid-body physics (`physicsobj/cars|helis|planes|trains/*.qvm`,
`DefinePhysicsObjType`) driven by input recorded in the editor. The `AnimTask` whose `TargetID` is the vehicle holds it
as `AnimData`: a count, then that many `(channel, value)` pairs. Channel 32 waits `value` ticks (30 Hz: the totals
match the cutscenes that run them); any other channel sets an input. 1,060 keys over 66 AnimTasks, all well formed.

| target | channel | values | reading |
|---|---|---|---|
| Car | 0 | -1, 0, 1 | steering (axis) |
| Car | 1 | 0..0.5, -0.25, -1 | throttle lever: set, then -1 a tick later ("key released", keep the value) |
| Car | 3 | 1, -1 | brake (pressed, released) |
| Car | 4 | -1 | unknown (released at start) |
| Heli | 0, 1, 2 | -1, 0, 1 | cyclic fore/aft (-1 nose down), cyclic lateral (+1 bank right), pedals (+1 turn right); fitted, see below |
| Heli | 3 | 0.84..1.2, -1 | collective lever (1 ≈ hover; `Original Thrust` is its start value) |
| Plane | 0, 1, 2 | -1, 0, 1 | stick and rudder axes |
| Plane | 3 | 0.8..1.25, -1 | throttle lever; 5..9 gear, canopy and similar switches |
| Train | 0 | 0..0.5, -1 | thrust lever (`Original thrust` is its start value) |

The AnimTask runs while its `Run` expression holds; keys play back on its own tick count, so a paused AnimTask (Mission
7's truck waits on `LevelTimer_2500` and `EditVariable_2003`) resumes where it stopped.

We do not run IGI's vehicle physics (most `DefinePhysicsObjType` parameters are undecoded). `vehicles.ts` replays the
inputs through simple models: cars follow the ground with bicycle steering (throttle lever × top speed); helicopters
tilt their rotor thrust (collective × g along the body's up axis, drag); planes fly along the nose. Helicopter and plane
paths are plausible, not exact.

### Helicopters (inferred, fitted)

The recordings are mostly short taps (2-6 ticks) that the pilot corrects with opposite taps, and long flights end
with the summed cyclic input far from zero, so the cyclic and pedals are **rate commands**: the tilt or heading changes
while a key is held and stays when it is released. The signs come from the flights: Mission 10's roof helicopter
(`Heli_707`) takes off at collective 1.2 and noses down on channel 0 = -1; Mission 1 and 3's intro helicopters start
nose-down and fly forward. The rates and the rest of `HELI_TUNING` were fitted offline against where the scripts and
cutscene cameras need the flights:

- **Mission 10's Huey** (`Heli_851`, 81.5 s) must carry Priboi off the main building's roof (`AreaActivate_159`; the
  outro's `Heli_707` sits there): 501 m from where it lifts off a hillside, 57 m lower. It starts on the ground at
  collective 1.4 and skims the hill at 1.04 before descending at 0.96, which only works with some ground effect.
- **Mission 1's insertion flight** (`Heli_1502`) must pass the "Heli flyby" camera of CutScene 1200 at 16-18.6 s, and
  **Mission 3's** (`Heli_602`) the "Helicopter flyby" camera of CutScene 701 at 11.9-15.1 s (650 m and 440 m away).
- **Mission 3's landing** (`Heli_603`, CutScene 702) sinks at collective 0.92 and must stay down when the pilot sets
  1.04 while Jones jumps out (`liftOff`).

Result (in the game): the Huey flies 494 m in 80 s and stops 14-22 m from the roof spot, 12-18 m above it (before:
it sank back onto the hillside or drifted ~50 m); the Mission 1 flyby passes 175 m from its camera (before ~430 m,
pitched up 50°); Mission 3's helicopter touches down at 9.2 s of the 9 s landing shot. The two intro flights hold
collective 1.5 throughout and still climb (capped at 4 m/s): IGI's own lift must fall off at speed in a way we do not
model. A helicopter whose AnimTask is not playing (not started, paused or played out) holds a hover where it is, or
stays on the ground; its rotors (`ROTOR` parts) stay out of its height and collision.

A rotor hub's ATTA rotation read like every other attachment's stands the Huey's main rotor on its side (mast
pointing back, blades vertical); its transpose puts the mast down and the blades level, so spinning hubs use the
transpose and spin about the local axis along the vehicle's up (main) or side (tail) axis.

**Mission 7's border truck** (`Car_351`, 233 s of input) is what the car model is fitted to, with the level script's
gating as the game runs it (`AnimTask_300.Run`):

1. The AnimTask pauses at `LevelTimer_2500` tick 2650 (88 s): the recorded drive brakes there, in the hamlet strip
   (`AreaActivate_169`, 8 × 40 m across the road).
2. `LevelTimer_2504` runs while a vehicle is in that strip; at 10 s it sets `EditVariable_2003` and the drive resumes.
3. It brakes for the front gate (`AreaActivate_166` opens it), and stops in "Game complete" (`AreaActivate_177`)
   exactly when the AnimTask pauses for good at tick 4330 (`EditVariable_2010` is never set).
4. Jones in the bed (`AreaActivate_173`) + the truck in 177 start the outro.

Replayed input drifts, so three corrections keep a scripted car on its script, all in `vehicles.ts`/`VehicleTask`:
the nearest vehicle area not yet visited slowly turns the car towards it (0.03 rad/s within 990 m) and, within 68 m,
shifts it sideways onto its line (2.3 m/s, heading unchanged); a car whose AnimTask is paused rolls on (or backs up) at
2.5 m/s into a vehicle area within 60 m and stops inside. The constants were fitted offline with that gating and hold
with each varied by 10-15 %; in the game the mission completes (truck, Jones in the bed, outro, "complete").

Scripted vehicles keep their last `CRITERIA_VEHICLE` answer while their task does not exist (as the player does): the
outro's own start takes the truck's container (`ConditionalContainer_559`, "!CutScene_1200.isRun") down, and dropping
the count stopped the outro again at once.

### CarAI

`CarAI(Car ID, Graph ID, Route ID)` under a `Car` drives it along a `PatrolPath` (Route ID) over an `AIGraph`
(Graph ID), with the soldiers' command ids (`ai.md`): 2/3 drive to node N (A* over the graph), 8 sets the speed in km/h,
1 waits N ticks, 6 repeats the commands after it, 7 stops. Missions 6, 7, 8, 10, 14 (APCs, T80 tanks, trucks, the limo).

### Destruction

Scripts test `Car_N.isExploded` (Mission 1 fails if the truck to steal is destroyed; Mission 10's Huey appears once the
tank is). Vehicles take full damage from blasts and 2 % from bullets (cars 12 health-bar units, aircraft 9; our
choice; Mission 7's hamlet guards shoot at the truck and the level fails if it explodes), and explode with a 6 m blast.
Blasts reach entities without a capsule through their own collider (one RPG-18 rocket destroys Mission 10's T80, which
brings in the Huey; its AnimTask then sets Priboi's path trigger at 74 s).

### Drawing

Vehicles draw their model with its `ATTA` attachments (wheels, rotors, doors). `magicobj/magicobj.qvm` types the parts
(`DefineMagicObj(model, model, TASKTYPE_*)`): `ROTOR` (711_01_1, 711_02_1, 712_01_1, 700_02_1, 700_03_1, 700_04_1)
spin, `WHEEL`/`HELIWHEEL` are the wheels. The `HumanSoldier` and `EditRigidObj` children of vehicles (passengers, a
rope ladder) are not carried yet.

Every attached part except spinning rotors is also a dynamic collider at its pose under the vehicle, reporting the
vehicle's entity: the T80's own collision set stops at 0.8 m above its origin, so a rocket aimed at its turret
(`614_02_1`, 0.7-2.7 m) flew through until the turret collided too (it now destroys the tank like a hull hit).

## Trains

`Train(Position, Original thrust, RailroadQTaskID, Model, ThrustStep, MaxSpeed, Flip, Displacement X/Y, Play Sound)`.
A train exists only while its ConditionalContainer runs (Mission 1 has five trains on one track, each for one
cutscene or gameplay phase); the mission system shows it, puts it back where the level places it each time its
container starts, and runs it while its AnimTask runs (or always, without one). Every car is a dynamic collider.

- **Where (confirmed on levels 1 and 10).** `Position` is the front of the locomotive, in world units along the
  railroad spline from its first waypoint; a negative value counts back from the far end. That is where the level
  editor left the train: its `Smoke` child sits on the locomotive there (levels 1 and 10), and the cutscene
  passengers placed with it sit on its cars (Mission 1: Jones lying on the flatcar of the driveby train, crouching on
  a boxcar roof of the train into the base). Cars trail behind the locomotive, spaced by their models' lengths.
- **Which way.** `Flip Direction` trains run towards the start of the track (every retail train is flipped).
- **How fast (inferred).** The thrust lever is a fraction of `MaxSpeed` (km/h): Mission 1's driveby train (0.5,
  100 km/h) passes the camera that films it in the 3.75 s the shot lasts, and the departing gameplay train (0.2, from
  1.0 km down the track) leaves the track as its 9 s container ends. A train enters play already moving at
  `Original thrust`; the thrust follows the lever (AnimData channel 0) by `ThrustStep` per tick, so a lever of 0
  brings it to a stop.

### Riding along: cutscene passengers and linked cameras

What a cutscene places in or on a vehicle keeps its offset from it: `world = current pose x inverse(level pose) x
placement` (`src/game/mission/carriers.ts`). A Heli/Car/Plane's level pose is its Position/Orientation; a train car's
is the car with the train at its `Position`. Riders are characters inside the vehicle task, or whose AI graph is
(see `ai.md`). An `EditCamera` with a `Link task ID` rides its object the same way, turning, pitching and banking
with it (the tail cameras and in-cabin closeups of the insertion helicopters, the camera on Jones's flatcar); a
`Target task ID` naming a train looks at that car. Static models inside a vehicle task ride it too (`Placement.carrier`;
the world system moves them with `MissionService.carrier` and gives them dynamic colliders): the cargo on Mission 1's
flatcar (nine crates and barrels Jones hides among; they were left on the rails where the train starts) and Mission
9's train, and the `715_01_1` cabin interior every gameplay Huey carries (levels 2-5, 8, 10-13), which stayed in the
air where the helicopter was placed.

## Ladders (confirmed)

Climbable ladders are not marked by a collision material (no model uses `MetalLadder`; Mission 4's water-tower ladder
`435_02_1` is tagged Fence). `magicobj/magicobj.qvm` lists them as `TASKTYPE_LADDER`: 314_01_1, 211_01_1, 400_17_1,
400_18_1, 402_02_1, 402_07_1, 417_02_1, 423_02_1, 422_03_1, 435_02_1, 240_01_1, 413_02_1. Physics reports
`RayHit.ladder` for them and lists them as `PhysicsService.ladders`. Levels place them as ATTA attachments of the
building or tower they serve (see world.md for the ATTA rotation), so the player finds them by walking the static
objects' attachments. A ladder's movement hull stands about 0.76 m proud of its rungs and the structure's decks close
over it; the climb itself follows the animation (player.md, Ladders) rather than the collision.

## Terrain

`DiscardTerrain(Position, Level)` removes the octree cube at that level containing the position (building pits,
shafts); collision and rendering skip it (merged from QA3).
