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
| Heli | 0, 1, 2 | -1, 0, 1 | cyclic fore/aft, cyclic lateral, pedals (axes; mapping inferred) |
| Heli | 3 | 0.84..1.2, -1 | collective lever (1 ≈ hover; `Original Thrust` is its start value) |
| Plane | 0, 1, 2 | -1, 0, 1 | stick and rudder axes |
| Plane | 3 | 0.8..1.25, -1 | throttle lever; 5..9 gear, canopy and similar switches |
| Train | 0 | 0..0.5, -1 | thrust lever (`Original thrust` is its start value) |

The AnimTask runs while its `Run` expression holds; keys play back on its own tick count, so a paused AnimTask (Mission
7's truck waits on `LevelTimer_2500` and `EditVariable_2003`) resumes where it stopped.

We do not run IGI's vehicle physics (most `DefinePhysicsObjType` parameters are undecoded). `vehicles.ts` replays the
inputs through simple models: cars follow the ground with bicycle steering (throttle lever × top speed); helicopters
tilt their rotor thrust (collective × g along the body's up axis, drag); planes fly along the nose. The car constants
were fitted so Mission 7's truck (`Car_351`, 233 s of input) passes its four `CRITERIA_VEHICLE` areas (hamlet, front
gate, "Game complete", rear gate) in order; because replayed input drifts, a car also turns gently onto a
`CRITERIA_VEHICLE` area within 80 m ahead of it. Helicopter and plane paths are plausible, not exact.

### CarAI

`CarAI(Car ID, Graph ID, Route ID)` under a `Car` drives it along a `PatrolPath` (Route ID) over an `AIGraph`
(Graph ID), with the soldiers' command ids (`ai.md`): 2/3 drive to node N (A* over the graph), 8 sets the speed in km/h,
1 waits N ticks, 6 repeats the commands after it, 7 stops. Missions 6, 7, 8, 10, 14 (APCs, T80 tanks, trucks, the limo).

### Destruction

Scripts test `Car_N.isExploded` (Mission 1 fails if the truck to steal is destroyed; Mission 10's Huey appears once the
tank is). Vehicles take damage from bullets and blasts (cars 12 health-bar units, aircraft 9; our choice) and explode
with a 6 m blast.

### Drawing

Vehicles draw their model with its `ATTA` attachments (wheels, rotors, doors). `magicobj/magicobj.qvm` types the parts
(`DefineMagicObj(model, model, TASKTYPE_*)`): `ROTOR` (711_01_1, 711_02_1, 712_01_1, 700_02_1, 700_03_1, 700_04_1)
spin, `WHEEL`/`HELIWHEEL` are the wheels. The `HumanSoldier` and `EditRigidObj` children of vehicles (passengers, a
rope ladder) are not carried yet.

## Trains

`Train(Position, Original thrust, RailroadQTaskID, Model, ThrustStep, MaxSpeed, Flip, Displacement X/Y, Play Sound)`.
A train exists only while its ConditionalContainer runs (Mission 1 has five trains on one track, each for one
cutscene or gameplay phase); the mission system shows or hides it and runs it while its AnimTask runs. The thrust
follows the lever (AnimData channel 0, else `Original thrust`) by `ThrustStep` per tick; without thrust a train rolls
to a stop. Every car is a dynamic collider.

## Ladders (confirmed)

Climbable ladders are not marked by a collision material (no model uses `MetalLadder`; Mission 4's water-tower ladder
`435_02_1` is tagged Fence). `magicobj/magicobj.qvm` lists them as `TASKTYPE_LADDER`: 314_01_1, 211_01_1, 400_17_1,
400_18_1, 402_02_1, 402_07_1, 417_02_1, 423_02_1, 422_03_1, 435_02_1, 240_01_1, 413_02_1. Physics reports
`RayHit.ladder` for them. A ladder's movement hull stands about 0.76 m proud of its rungs and the structure's decks
close over it, so the player grabs within 1.3 m, hugs the rungs at 0.4 m and climbs through decks.

## Terrain

`DiscardTerrain(Position, Level)` removes the octree cube at that level containing the position (building pits,
shafts); collision and rendering skip it (merged from QA3).
