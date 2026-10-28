# World: sky, lighting, lightmaps, LOD, splines

Notes from the world workstream. Readers: `src/formats/olm.ts` (`.olm`, LTMP, ATTA), `src/game/world/environment.ts`
(environment tasks), `src/game/world/statics.ts` (lightmap assignment, LOD chains), `src/game/world/splines.ts`
(SplineObj, Train). Confidence as in `../FORMATS.md`: **confirmed** = checked over all 14 levels; **inferred** = our
reading of names and data, not proven against the engine.

## Environment tasks (objects.qvm, "EnvironmentalEffects" container)

Parameter layouts come from each type's `Task_DeclareParameters`. How the renderer uses the sky and fog values follows
hjcminus/Project-IGI-Terrain (see THIRD_PARTY.md).

| task | parameters | use |
|---|---|---|
| `FlatSky` | fog amount, z pos (m), distance (m), fog colour, snap colours, dome angle (deg), top, middle 1, middle 2, bottom 1, bottom 2 | sky dome colours; cloud plane height and fade; clear colour |
| `FlatSkyLayer` (x2) | texture path, scale, x speed, y speed, alpha, colour | cloud layers, `missions/location0/common/textures/sky_layer{1,2}.tex` (64x64 / 64x32 ARGB8888) |
| `GlobalLight` | radiosity intensity, texture filter ambient / scale / gamma | not used (texture filter unknown) |
| `GlobalLightKeyframe` (x2) | link button; 5 x (ambient RGB, fog RGB, fog density, link) for terrain and object categories 1-4; sky colour; water ambient; water colour; time | ambient and fog |
| `Dirlight` + `DirlightKeyframe` (x2) | beta, gamma, front colour, back colour, time | the sun |
| `LODSettings` | first switch (spline, rigid, bone), cutoff (spline, rigid, bone), radius exponent, ideal radius | LOD distances |
| `MipMapControl` | LOD blend, mode, bias x2 | not used |

Every level has two keyframes per light: time 12 (used) and time 100 (black front colour; never reached, inferred).
Colours are raw 0..1 values and can exceed 1 (level 2's sky top is 1.13); we clamp.

- **Sky dome** (hjcminus): a hemisphere of 15 rings x 20 slices plus a skirt to -0.5 R. Above the dome angle colours go
  from middle to top, below it from bottom to middle; within a band the colour also crosses from colour 1 to colour 2
  over the rings.
- **Cloud layers** (hjcminus): a plane `z pos` metres above the eye that follows the camera. UV = (point on the plane
  relative to the eye, world units) x scale + scroll. Opaque up to `fogStart = D - (D - 0.1 m) x fog amount` forward
  depth, then alpha `(fogStart / z) x (D - z) / (D - fogStart)`, `D` = distance. Scroll speed is per game tick (we use
  30 Hz, inferred). Blended with `SrcAlpha, 1 - SrcAlpha`.
- **Fog**: terrain fog colour and density from the GlobalLightKeyframe. hjcminus maps density to a far distance of
  `7200 / density` of its renderer units = `7.2e6 / density` world units (level 1: 1.89 → 930 m; level 14: 9.5 → 185 m;
  level 2: 0.18 → 9.8 km), and starts the fog at a third of that. Linear in distance from the eye. Inferred
  ("tune this" in the source), but it gives each level its familiar haze.
- **Sun**: towards-sun vector `(-sin γ cos β, cos γ cos β, sin β)` in IGI space (yaw convention of `coords.direction`).
  Checked against the baked shadows in the terrain lightmaps of level 1 (shadows fall east, the sun is west-north-west).
  Objects without lightmaps get `back + front x max(0, n·l)`, back = "Back Color" (equal to the terrain ambient in every
  level).

## Per-object lightmaps: `lightmaps/lightmaps.res` → `.olm` (confirmed)

An IRES archive of `objNNNNN_MMMMM.olm`. `objNNNNN` is the "Filename" of a `LightmapInfo` task; the LightmapInfo is a
child of the task that owns the lit objects (a `Building` with its `Static` children, doors, terminals, ...).

```
.olm
  0   f32 0.12, f32 0.1          same in every file
  8   u32 year, month, day, hour, minute, second, millisecond   when the lightmapper wrote it (2000-11-21 ...)
 36   u32 ?, u32 ?, u32 pages    pages = 1 except in 11 files (2 or 3): further pages follow page 0 (not decoded)
 48   u32 ?, u32 ?, u32 ?, u32 0
 64   u16 allocWidth, u16 allocHeight     power of two
 68   u16 ?, u16 3
 76   f32 width / allocWidth, f32 height / allocHeight
 84   u32 0, u32 0, u32 ?, u32 0
100   u16 width, u16 height      the image; equals the model's LTMP size
104   BGRA8888 pixels, width x height, top row first
```

Lightmaps are colour and already contain the ambient term (unlit texels of level 1 are (68, 73, 83) = the terrain
ambient). The game multiplies them with the texture; we use plain modulate (x1).

**Which file belongs to which model** (confirmed for 98.4% of files): `MMMMM` counts the models of the owning task's
subtree in the order the lightmapper visited them:

- a task: its model (the first parameter that looks like `GGG_VV_L`), then its child tasks in order;
- a model: each LOD `_1`.._5` that exists and has an `LTMP` chunk (an empty `LTMP` takes a number but has no file),
  then its attachments: first those whose model has no portals (`PORT` empty), then those with portals (rooms), each
  recursively.

Walking that order and matching image sizes places 24,937 of the 25,337 files; the rest (security cameras with extra
parts, a few rooms in levels 12-14) are skipped by resynchronising on image size.

## .mef additions

- **`LTMP`** (type 3): `u16 width, u16 height, u32 0` — the lightmap the second UV set (`VRTX` +32, 0..1) is laid out
  for. Some models carry an empty `LTMP` (no lightmap).
- **`ATTA`**: 68-byte records `char[16] model, vec3 position, f32[9] rotation (rows), u32 0`. Sub-models a model brings
  with it, in its own model space: building interiors (`403_02_1` ... rooms with portals), lamps, windows, railings,
  furniture. They are not tasks in objects.qvm, so nothing else places them. Attachments can have attachments.
- **REND** type 3 header `u16` @18 is 0 or 1; not a lightmap page (single-page lightmaps use both). Unknown.

## Level of detail (inferred)

`pc/lod.qvm` holds `Task_New(-1, "ModelLODSettings", name, model, lod1, lod2, lod3, lod4, cutoff)` for 462 models
(flawme's table). Small values (a camera: 5, 7, 9, 9, cutoff 9) only make sense relative to object size, so we read
them, like `LODSettings`, as multiples of an effective radius `r' = ideal x (r / ideal)^exponent` (m; ideal 15,
exponent 0.25 in every level). Models without an entry switch at `firstSwitch x r'` and doubling distances, and are cut
off at `cutoff x r'`.

## Spline objects and trains (inferred)

- `SplineObj` (linear segments, display waypoints, snap length, automatic orientation, matrices per segment, collision
  LOD, position, gamma, dirlight colours) with `SplineObjWaypoint` children (orientation, position, waypoint model,
  segment model, areas, align, flip, automatic orientation). Segment models (`368_01_1` rail embankment 130 m long,
  `322`/`323` rails, `320_02_1` power-line wire) span X from 0 (or -L/2) to L. We bend waypoint i's segment model onto
  the stretch to waypoint i+1 (X → along the path, Y sideways, Z up), on a Catmull-Rom curve or straight lines when
  "Linear Segments" is set. Waypoint orientations and "areas" are not used.
- `Train` (position, thrust, railroad task id, model, thrust step, max speed, flip, displacement x/y, sound) with child
  `Train` tasks as wagons. Position is a distance along the railroad spline in world units (negative = still off the
  track); flipped trains count from the far end. A train whose `AnimTask` has the run condition `"1"` starts moving at
  load; others wait for a script (`WorldService.train(id).running = true`). Thrust read as m/s², MaxSpeed as km/h.
  The AnimTask key data (which probably drives thrust) is not decoded.
