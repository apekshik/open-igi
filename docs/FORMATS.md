# IGI 1 data formats

What we know, how sure we are, and where the reader lives. All integers are little-endian.
Confidence: **confirmed** = parser runs over every file of that type in a full install; **partial** = some
fields understood; **unknown** = only the magic is known.

Reference install: the English PC release (`IGI.exe`, 1,384,448 bytes), 1,940 files, ~400 MB.

## Overview

| ext | count | MB | magic | status | reader |
|---|---:|---:|---|---|---|
| .res | 92 | 274.5 | `ILFF` / `IRES` | confirmed (container) | `src/formats/ilff.ts` |
| .wav | 394 | 47.1 | `ILSF` | unknown | |
| .dat | 317 | 35.2 | `0xccddeeff` / text | unknown | |
| .tex | 26 loose + ~6,900 in archives | 7.2 | `LOOP` | v11 confirmed | `src/formats/tex.ts` |
| .ctr / .cmd / .hmp | 14 / 14 / 6 | ~13 | none | terrain geometry confirmed | `src/formats/terrain.ts` |
| .lmp / .bit | 14 / 14 | ~8 | none | layout known, not yet used | |
| .iff | 6 | 5.2 | `FORM` / `BOBJ` | unknown (animations) | |
| .qvm | 997 | 3.7 | `LOOP` (v8) | declarative subset confirmed (all objects.qvm) | `src/formats/qvm.ts` |
| .mef | 6,794 in archives | | `ILFF` / `OCEM` | render geometry confirmed | `src/formats/mef.ts` |
| .olm | ~25,000 in archives | | none | unknown (per-object lightmaps) | |
| .mtp | 17 | 0.4 | `FORM` / `MTP ` | model→texture mapping confirmed | `src/formats/mtp.ts` |
| .fnt | 2 + in archives | | `ILFF` / `FONT` | unknown | |
| .avi | 5 | 2.4 | `RIFF` | standard AVI | browser / ffmpeg |

Per-level layout: `missions/location0/levelN/` holds `models/levelN.res`, `textures/levelN.res`,
`lightmaps/lightmaps.res`, `terrain/terrain.*`, `ai/*.qvm` (one per AI actor id), `graphs/graph*.dat`
(AI navigation graphs, presumably), `objects.qvm` (object placement) and `mission.qvm`.
Shared assets live in `missions/location0/common/` and `common/`.

## ILFF container (confirmed)

```
file   := "ILFF" u32 fileSize  u32 align  u32 reserved  tag4 formType  pad-to-align  chunk*
chunk  := tag4 u32 length  u32 align  u32 next  u8[length]
```

- `fileSize` equals the file length.
- `align` is 4 in most files and 32 in some archives (e.g. `common/textures/common.res`). The first chunk begins
  at the 20-byte header rounded up to `align`.
- `next` is the distance from this chunk's header to the next chunk's header; `0` ends the list.
- Used by archives (`IRES`), models (`OCEM`) and fonts (`FONT`).

### IRES archive

A flat list of `NAME` + `BODY` pairs. `NAME` is a NUL-terminated virtual path such as
`LOCAL:models/003_01_3.mef`. `BODY` is the file's bytes. The `LOCAL:` prefix appears to be relative to the
archive's mission folder; shared archives use paths like `LOCAL:common/sounds/...`.

Open questions:
- The `language/*/*.res` archives contain no `BODY` chunks (different chunk tags, probably string tables).
- 232 entries in `common/textures/common.res` start with four zero bytes rather than a known magic.

## .tex texture, v11 (confirmed for v11)

```
 0  "LOOP"
 4  u32 version              11 in all mission archives; 2 in loose common/textures/*.tex (24-byte header)
 8  u16 format               2 = 16-bit ARGB1555, no mips
                              67 (0x40 | 3) = 32-bit ARGB8888 followed by a full mip chain to 1x1
10  u8[10] zero
20  u16 unknown              5 in every file seen
22  u16 width, u16 height
26  u16 width, u16 height    repeated; never seen to differ
30  u16 bytesPerPixel        2 or 4
32  pixels, row-major from the top-left
```

Sizes check out exactly: format 2 is `32 + w*h*2`; format 67 is `32 + 4 * sum(mip sizes)`.
ARGB8888 is stored as B, G, R, A bytes. Filenames of 32-bit textures end in `_argb8888`.

## .mef model (render geometry confirmed)

ILFF with form type `MECO`. Chunk tags, like the form type, are little-endian u32s, so they read reversed on
disk (`HSEM` = `MESH`). Chunks in file order:

| tag | meaning (best guess unless noted) |
|---|---|
| `MESH` | 156-byte header. u32 @32 = model type (confirmed); u32 @96 = triangle count, u32 @100 = vertex count (confirmed); bounding spheres at @48.. |
| `ATTA` | attachment points |
| `MVTX`, `PORT`, `PTVX`, `PTFC` | portal / visibility data |
| `RD3D` | render header (48 or 56 bytes) |
| `REND` | draw batches (confirmed, below) |
| `VRTX` | vertices (confirmed, below) |
| `LTMP` | lightmap reference (type 3) |
| `CMSH`, `CVTX`, `CFCE`, `CMAT`, `CSPH` | collision mesh, vertices, faces, materials, spheres (two sets) |

**Model type** (`MESH` @32): `3` static lightmapped geometry (5,616 models), `1` skinned characters (~550),
`0` rigid movable objects (~630). Type 1 vertices are in bone space, so characters need the skeleton to look right.

**VRTX**: `vertexCount` records of 40 bytes (types 1, 3) or 32 bytes (type 0):
`vec3 position, vec3 normal, vec2 uv` then, for 40-byte vertices, `vec2 lightmapUV` (type 3) or bone data (type 1).
IGI is Z-up. UV v=0 is the top row of the texture.

**REND**: back-to-back batches, each a header followed by `indexCount` u16 triangle-list indices relative to
`vertexStart`, with no padding.

```
type 3 (32 bytes):     vec3 centre, u16 indexCount, u16 ?, u16 material, u16 ?, u16 vertexStart, u16 vertexCount, u8[8]
types 0, 1 (28 bytes): vec3 centre, u16 indexCount, u16 ?, u16 material, u16 vertexStart, u16 vertexCount, u8[6]
```

`material` 0xFFFF means untextured. All 6,794 models in the 14 levels parse with every batch in bounds and
`REND` consumed exactly.

Model names are `GGG_VV_L`: `L` is the LOD level (1 = most detailed, up to 5).

## .mtp material table (model→texture confirmed)

Big-endian IFF `FORM` of type `MTP ` (sizes big-endian, payloads little-endian, chunks padded to even length).

| chunk | contents |
|---|---|
| `MODS` | u32 count, then NUL-terminated model names, matching the level's models archive |
| `VNAM` | u32 count, then one u32 per model; not offsets into `INST` (meaning unknown) |
| `INST` | one record per model in `MODS` order: `u32 modelIndex, u32 n, u32 texIndex[n]` |
| `TEXF` | u32 count, then NUL-terminated texture names, same order as the level's textures archive |
| `GTT ` | u32 count, then `(u32 index, i32 -1)` pairs; identity so far |
| `BANM`, `SNDS`, `SVOL`, `PALF` | empty in level 1 |

A model's material slot `i` uses texture `TEXF[INST.texIndex[i]]`. In all 14 levels, the records are sequential,
`n` equals the model's material count, every index is in range, and the records consume `INST` exactly.

## ILSF sound (partial)

```
0  "ILSF"
4  u16 codec?       1 in common/sounds, 2 in mission dialogue (payload of 2 does not look like PCM)
6  u16 bits         16
8  u32 channels     1
12 u32 sampleRate   22050
16 u32 dataSize
20 data
```

## .qvm compiled script (declarative subset confirmed)

`LOOP` version 8. Compiled from QSC source. Header (all u32):

| offset | field |
|---|---|
| 0x04 | version (8) |
| 0x08 | unknown (5) |
| 0x0C, 0x10 | identifier offset table, identifier string pool (function names and constants like `TRUE`) |
| 0x14, 0x18 | identifier table size (4 per entry), pool size |
| 0x1C, 0x20 | string offset table, string pool |
| 0x24, 0x28 | string table size, pool size |
| 0x2C, 0x30 | bytecode offset, bytecode size (ends exactly at end of file) |

Bytecode is a list of statements, each a call followed by `12`, with a final `00`:

```
call    := 0d u8:ident  18 u32:n  u32:argStart[n]  14 u32:argBytes  arg[n]
arg     := expr* 00
```

`argStart` is relative to the start of the bytecode. Argument expressions are tiny stack programs:

| op | operand | meaning |
|---|---|---|
| `03` | i8 | push int |
| `04` | i16 | push int |
| `05` | f32 | push float |
| `09` | u8 | push string (index) |
| `0a` | u16 | push string (index) |
| `0d` | u8 | identifier; followed by `18…` it is a nested call, otherwise a name such as `TRUE` |
| `0f` / `10` | | push 0 / 1 |
| `2c` | | negate top of stack |

That subset decodes every `objects.qvm`, ammo and most weapon definitions (124 of 997 scripts). AI scripts also use
control flow (`02`, `1b` and statement forms beyond `call 12`), not yet mapped.

### objects.qvm

A tree of `Task_New(id, type, name, ...params, ...children)` calls. The file first declares each type's parameters
with `Task_DeclareParameters(type, paramName, paramType, ...)`, e.g. `Building(Position: ObjectPos,
Orientation: Real32x9, Model: String16)`. Engine-defined types (`EditRigidObj`) are not declared.

| type | params used by open-igi |
|---|---|
| `Building`, `EditRigidObj` | x, y, z, three Euler angles (radians; third is about Z), model name; `EditRigidObj` then has scale (1,1,1) and three zeros |
| `Fence` | x, y, z, gamma (about Z), model |
| `Wire` | start xyz, stop xyz, model |
| `HumanPlayer` | x, y, z, gamma, model, team (the player; Mission 1 calls it "TheGoodGuy") |
| `HumanSoldier` | x, y, z, gamma, model, ... (AI soldiers, with `HumanAI` children) |
| `HeightMap` | x, y, z, then (11, 128, FALSE, tileIndex, 8, 7) in Mission 1 |

World units equal model units, roughly 4,000 per metre (the army truck is ~30,000 long). Z is up. Mission 1's
compound ground is at z ≈ 174,413,100. Whether IGI's axes are mirrored relative to three.js is not yet confirmed.


## Terrain (geometry confirmed)

Layouts and the octree walk follow hjcminus/Project-IGI-Terrain (see THIRD_PARTY.md); flawme/igi-reverse-engineering
documents the same files. Every level has `terrain/terrain.{ctr,cmd,lmp,tex,bit,qvm}`; six levels also have `.hmp`.

**World:** one root cube of half-size 2^30 units centred on the origin, subdivided as an octree. A cube at level L has
half-size 2^(30-L); leaves are level 16 (32,768 units, 8 m). World scale is 4096 units per metre, X right, Y forward,
Z up (right-handed; matches the hjcminus renderer, so levels are not mirrored).

**`.ctr`** — 32-byte cube records. Record 1 is the root (record 0 is all zero).

```
int16 children[8]; int8 transform[8] (-1 = empty); u8 childMask; u8 pad[3]; u32 cmdOffset
```

The tree is a DAG: identical subtrees are shared and placed under one of 8 transforms (4 rotations about Z, each
optionally mirrored in X). Child slot k sits in octant (x = k&1, y = k&2, z = k&4). Under parent transform t, octant k
holds stored child `CHILD_FOR_OCTANT[t][k]`, and that child's transform becomes `COMPOSE[t][child.transform]`
(tables in `src/level/terrain.ts`).

**`.cmd`** — every cube (not just leaves) has a mesh at `cmdOffset`, so any level can stand in for its subtree:

```
u16 triangleCount, u16 vertexOffset (= triangleCount*4), u16 parentVertexCount, u16 childVertexCount
u32 triangle[triangleCount]   bytes 0..2 vertex indices, byte 3 flag (0xE0/0xF0; high nibble likely material)
u32 vertex[parent + child]    x = bits 26..31, y = 20..25, z = 14..19, each minus 24 (so -24..24)
```

Vertex world position = `coord * 2^(27-L) / 3 + cubeCentre`, after applying the cube's transform to x/y. Triangle
order is (b2, b0, b1), or (b1, b0, b2) when the transform mirrors.

**`.hmp`** — 256 slots of `{u32 runtimePtr, u8 ?, u8 pad[3], u32 size}`, then for each non-empty slot a
`(size+1)²` grid of u8 heights. A `HeightMap` task in objects.qvm (`x, y, z, level, size, isEdit, id, ...`) attaches
slot `id` to the level-`level` cube containing its position; the grid spans that cube. Cubes at level ≥ 14 inside
it add `(bilinear(h) - 64) * 256` to their vertex heights.

**Check:** with patches applied, Mission 1's 400 placed objects sit a median 0.00 m above the decoded ground
(10th–90th percentile: -0.5 m to +2.3 m).

**Level of detail.** A cube at level L is drawn (instead of its children) once its face distance (Chebyshev,
view to nearest face) reaches `163 * 2^(25-L)`; leaves (L=16) are always drawn. Within a cube, each child vertex
(the `.cmd` vertices after the parent ones; low 6 bits = its parent vertex) slides onto its parent vertex by
`factor = clamp(d / (2^(25-L) * 99) - 227/99, 0, 1)`, where d is its parent vertex's Chebyshev distance to the view.
That closes cracks between neighbouring cubes at different levels. open-igi divides distances by a `detail`
multiplier (default 4; `?detail=1` matches the game).

### Texturing

| file / task | contents |
|---|---|
| `terrain.tex` | LOOP v9: 18 images, 128×128 ARGB1555 (52-byte header, 32-byte image descriptors) |
| `terrain.qvm` | `CreateTerrainMaterial(m, id, 32 × {bool, v1, v2, freq2, tileMap2, freq1, tileMap1})` per material and octree level; `CreateTerrainTileMap(g, 64 texture indices)` (8×8) |
| `.bit` | same 256-slot table as `.hmp`; each slot a size×size 1-bit mask |
| `TextureModifier` task | x, y, z, level, material, bitmap slot, size, isEdit: paints `material` where the mask is set, over the level-`level` cube containing the position |
| `.lmp` | back-to-back `u32 size, u8[size²]` greyscale lightmaps (268 in Mission 1) |
| `TerrainLightMap` task | x, y, z, level, size, lmp index, generated: lightmap spanning the level-`level` cube |

Per vertex, the material is the first modifier (innermost cube first, at most four; within one cube, the first in
script order) whose mask bit is set at the vertex, else material 0. Each material present in a cube draws two
textures: near (`tex1`, frequency `freq1`/2) and far (`tex2`), each chosen from its 8×8 tile map by
`((int)(freq * cubeCentre) >> (22-L or 23-L) & 0x7ff) >> 8`. UVs are planar in x/y; vertices with projection
bits (bits 8–9 for tex1, 6–7 for tex2) map v to height instead, for cliffs. Near and far textures cross-fade with the
morph factor, and child vertices blend between their own and their parent's material.

The original draws three passes: the first material's near texture opaque, every other layer additively with
per-vertex weights summing to 1, then the lightmap multiplied in as `1/3 + 2/3 × lightmap`. Texture rows are
stored top-down with v=0 at the first row, for both ground textures and lightmaps.
