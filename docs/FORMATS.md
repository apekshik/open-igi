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
| .iff | 6 | 5.2 | `FORM` / `BOBJ` | skeletons confirmed, animation keys partial | `src/formats/anim.ts` |
| .qvm | 997 | 3.7 | `LOOP` (v8) | declarative subset confirmed (all objects.qvm) | `src/formats/qvm.ts` |
| .mef | 6,794 in archives | | `ILFF` / `OCEM` | render geometry and type 1 skin confirmed | `src/formats/mef.ts` |
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
`0` rigid movable objects (~630). Type 1 vertices are in bone space, so characters need the skeleton to look right
(see "Characters" below).

**VRTX**: `vertexCount` records of 40 bytes (types 1, 3) or 32 bytes (type 0):
`vec3 position, vec3 normal, vec2 uv` then, for 40-byte vertices, `vec2 lightmapUV` (type 3) or skin data (type 1:
`f32 weight, u16 index, u8 bone, u8 0`). IGI is Z-up. UV v=0 is the top row of the texture.

**REND**: back-to-back batches, each a header followed by `indexCount` u16 triangle-list indices relative to
`vertexStart`, with no padding.

```
type 3 (32 bytes):     vec3 centre, u16 indexCount, u16 ?, u16 material, u16 ?, u16 vertexStart, u16 vertexCount, u8[8]
types 0, 1 (28 bytes): vec3 centre, u16 indexCount, u16 ?, u16 material, u16 vertexStart, u16 vertexCount, u8[6]
```

`material` 0xFFFF means untextured. All 6,794 models in the 14 levels parse with every batch in bounds and
`REND` consumed exactly.

Model names are `GGG_VV_L`: `L` is the LOD level (1 = most detailed, up to 5).

## Characters: type 1 skin + `.iff` skeletons (bind pose confirmed, animation partial)

Readers: `src/formats/mef.ts` (`skin`, `skinMef`, `skinFitError`) and `src/formats/anim.ts` (`parseAnimFile`,
`poseBones`). Chunk sizes and the BOSH/PLST/TLST/BALH meanings come from flawme/igi-reverse-engineering; the skin
layout, the bind-pose rule and the key layouts are our own reading (see THIRD_PARTY.md).

### Skin (in the `.mef`)

For type 1, `RD3D` is 56 bytes: `u32 4, triangleCount, batchCount, extraCount, renderCount, vertexCount, 0...`.
`VRTX` holds `renderCount` render vertices followed by `extraCount` extra influence records, all 40 bytes:

```
vec3 position, vec3 normal   in the bind frame of `bone`
vec2 uv
f32  weight
u16  index                   render vertex: its index within its REND batch (unused)
                             extra record:  the model-wide render vertex it adds to
u8   bone, u8 0
```

Each record carries one bone. A vertex weighted to several bones has its own record plus one extra record per
additional bone (extras come in passes: all second influences, then third, then fourth). REND only references render
vertices. Posed position = sum over a vertex's records of `weight * (boneRotation * position + boneOrigin)`; normals
likewise without the translation.

Checks, over all 537 type 1 models in every archive: RD3D counts add up, every extra targets a render vertex, every
batch index is below `renderCount`, and the weights of each render vertex sum to 1 (0 exceptions). `ATTA` and `MVTX`
play no part in skinning: `ATTA` is empty in every type 1 model and `MVTX` is empty in 523 of 537 (one 16-byte record in
the rest).

### `.iff` (common/anims/NNN.iff)

EA IFF 85: big-endian chunk sizes, little-endian payloads, chunks padded to even length. The `FORM` sizes do not
nest (BOBJ's size covers only the skeleton, and the last BOAN runs past the end of BOAL), so the reader walks the
file as a flat stream of chunks and treats each `BOAH` as the start of an animation.

```
FORM BOBJ
  FORM BOBH
    BOSH  u32 hierarchy, u32 boneCount         hierarchy = the file number (000.iff → 0)
    PLST  i32 parent[boneCount]                -1 for the root; parents always precede children
    TLST  vec3 offset[boneCount]               bone origin relative to its parent, in the parent's frame
  FORM BOAL
    BALH  u32 animationCount, u32 ?            animationCount matches the BOAN count in all 6 files
    FORM BOAN  (per animation)
      BOAH  f32 duration, u32 flags, u32 id    flags bit 31 set on the walk/run cycles (looping?); id = animation number
      BOTH  u32 n
      BOTD  n x { vec3 rootPosition, f32 time, vec3 ?, vec3 ? }       root track (the trailing vec3s look like tangents)
      BORH  u32 n                                                      } once per bone, in bone order
      BORD  n x { quat (x, y, z, w), f32 time, quat ?, quat ? }        } rotation relative to the parent
      BOEH  u32 n;  BOED  event data (not decoded)
```

| file | bones | animations | used by |
|---|---:|---:|---|
| 000.iff | 33 | 122 | Jones (`000_*`) |
| 001.iff, 002.iff, 003.iff | 33 | 95, 18, 47 | soldiers; the three share one skeleton |
| 005.iff | 56 | 78 | first-person arms (`005_01_1`), with finger bones |
| 006.iff | 33 | 16 | Anya and the heavier build (`012_*`, `015_*`) |

Bone order for the 33-bone rigs: 0 root/pelvis, 1-3 spine, 4-7 neck and head, 8-13 left arm to fingers, 14-19 right
arm, 20-22 a chain in front of the chest (likely the weapon), 23-27 left leg to toe, 28-32 right leg.
X is the character's right, Y forward, Z up. The root sits about 4,000 units (1 m) above the feet.

**Bind pose (confirmed).** Rest rotations are identity: a bone's model-space origin is the sum of TLST offsets down
the hierarchy, and a record's bind position is `position + origin(bone)`. Proof: every extra record must land on the
same point as the render vertex it adds to. With the right skeleton the largest mismatch is under 1 unit for most
models and at most ~60 units (1.5 cm) for the rest; wrong skeletons give hundreds. 006_01 and 008_01 fit best at 129
and 242 units but still look right; 005_01_1 (arms) fits 005.iff at 731, so its bind frame is less certain.

**Which skeleton.** In game the placement picks it: `HumanSoldier(..., Model, Team, Bone Heirachy, Stand Animation,
...)` in objects.qvm, with Bone Heirachy 0 for Jones, 1 for soldiers and 6 for Anya, which matches the best-fitting
skeleton. A model can be driven by another skeleton (Jones's mesh appears with hierarchy 1), since vertices are
bone-relative. The model viewer has no placement, so it uses the best-fitting skeleton.

**Animation (partial).** Local bone transform = translate(TLST offset, plus the BOTD root position for bone 0) ·
rotate(BORD quaternion); model = parent · local. Sampling slerps between bracketing rotation keys and lerps the root
position, with time in what looks like milliseconds. Animation 0 of 000.iff is a relaxed standing pose, and the
walk/run cycles of 001.iff play convincingly. Not decoded: the second and third quaternions in BORD (equal to the
first in single-key tracks; the game's sampler interpolates with SLERP and precomputes per-key angles, so they may be
spline controls), the BOTD tangents, BOAH flags beyond bit 31, BALH[1], the BOED events, and how "Stand Animation"
ids map to BOAH ids.

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

Not yet used: `.lmp` (8-bit lightmaps: repeated `u32 size, u8[size²]`), `terrain.tex` (LOOP v9, 18 textures of
128×128 ARGB1555), `.bit` (texture-modifier bitmaps, same slot table as `.hmp` but 1 bit per cell), and
`terrain.qvm` (`CreateTerrainMaterial` and tile-map tables).
