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
| .qvm | 997 | 3.7 | `LOOP` (v8) | confirmed (all 997 decode) | `src/formats/qvm.ts` |
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

## .qvm compiled script (confirmed)

`LOOP` version 8. Compiled from QSC source (the `.qsc` files are not shipped). `src/formats/qvm.ts` decodes all 997
scripts in the install (`npm run qvm -- <install dir>` prints decoded/total). Opcode names, numbering and the
interpreter behaviour below come from flawme/igi-reverse-engineering (`reverse/docs/03-scripting`, from `IGI.exe`); the
statement patterns and the decoder's strict checks are ours. Header (all u32):

| offset | field |
|---|---|
| 0x04 | version (8) |
| 0x08 | section count (5) |
| 0x0C, 0x10 | identifier offset table, identifier string pool (function names, constants like `TRUE`, variables) |
| 0x14, 0x18 | identifier table size (4 per entry), pool size |
| 0x1C, 0x20 | string offset table, string pool |
| 0x24, 0x28 | string table size, pool size |
| 0x2C, 0x30 | bytecode offset, bytecode size (ends exactly at end of file) |
| 0x34, 0x38 | value-stack and type-stack sizes; 0 in every file (engine defaults 0x800 / 0x100) |

The sections tile the file in order from 0x3C.

### Instructions

A stack machine. Each instruction is a one-byte opcode with a fixed-width operand (except `PUSHS`/`PUSHI` and `CALL`).
Branch targets are relative to the end of the branch instruction. All offsets are relative to the start of the code.
`IGI.exe` names opcodes from a 49-entry table stored in reverse order (opcode = 48 − index).

Confidence: **seen** = emitted by the retail compiler and decoded strictly over all 997 files (count in brackets);
**exe** = never emitted, but its handler and operand width are known from `IGI.exe`; **inferred** = never emitted,
named from the exe's table only, assumed operand-less.

| op | name | operand | meaning | confidence |
|---|---|---|---|---|
| `00` | BRK | | end of an argument fragment or of the script (sets the VM's break flag) | seen (374,345) |
| `01` | NOP | | no-op | inferred |
| `02` | PUSH | i32 | push int | seen (8, `humanplayer.qvm`) |
| `03` | PUSHB | i8 | push int | seen (40,286) |
| `04` | PUSHW | i16 | push int | seen (10,346) |
| `05` | PUSHF | f32 | push float | seen (74,191) |
| `06` | PUSHA | i32 | push "address" (type tag 5; nothing consumes it) | exe |
| `07` | PUSHS | inline C string | push string literal | exe |
| `08` / `09` / `0a` | PUSHSI / PUSHSIB / PUSHSIW | u32 / u8 / u16 | push string from the string table | `09`, `0a` seen (32,754 / 56,356); `08` exe |
| `0b` | PUSHI | inline C string | push symbol by name | exe |
| `0c` / `0d` / `0e` | PUSHII / PUSHIIB / PUSHIIW | u32 / u8 / u16 | push symbol from the identifier table | `0d` seen (54,260); `0c`, `0e` exe |
| `0f` / `10` / `11` | PUSH0 / PUSH1 / PUSHM | | push 0 / 1 / −1 | `0f`, `10` seen (59,821 / 59,761); `11` exe |
| `12` | POP | | discard top of stack; ends an expression statement | seen (6,838) |
| `13` | RET | | halts with "illegal instruction" | exe |
| `14` | BRA | i32 | jump | seen (37,966) |
| `15` | BF | i32 | pop; jump if false | seen (3,748) |
| `16` | BT | i32 | pop; jump if true | exe |
| `17` | JSR | | halts with "illegal instruction" | exe |
| `18` | CALL | u32 n, u32 argStart[n] | pop symbol, call native function, push result | seen (34,218) |
| `19`–`29` | ADD SUB MUL DIV SHL SHR AND OR XOR LAND LOR EQ NE LT LE GT GE | | pop b, pop a, push `a op b` (C operators; comparisons push 0/1) | seen: ADD 4, MUL 25, LAND 42, LOR 1, EQ 3,630, NE 42, LT 29, GT 30; others exe (one shared ALU handler) |
| `2a` | ASSIGN | | pop value, pop variable symbol, store, push value | seen (46) |
| `2b` | PLUS | | unary + | inferred |
| `2c` | MINUS | | negate | seen (39,028) |
| `2d` | INV | | bitwise not `~` | inferred |
| `2e` | NOT | | logical not `!` | seen (15) |
| `2f`, `30` | BLK, ILLEGAL | | unknown | inferred |

25 opcodes appear in the retail data. `LAND`/`LOR` are plain binary ops: the compiler does not short-circuit.

### Statement patterns

The retail compiler's output is regular, and `decodeQvmScript` accepts only these shapes (every byte accounted for once):

```
script  := stmt* 00
stmt    := expr 12                                         expression statement, value discarded
         | expr 15:else  stmt*  14:end  else: stmt*  end:   if (expr) {…} else {…}
call    := 0d:fn 18 n argStart[n]  14:end  arg[0] … arg[n-1]  end:
arg     := expr 00
```

- A call pushes its callee, then `CALL`; the inline argument fragments follow a `BRA` that skips them. The native
  function evaluates each fragment on demand by running from `argStart[i]` to its `BRK`.
- `if` always ends its then-branch with a `BRA`; when there is no else branch it jumps to the next instruction. So
  `if (c) {…}` and `if (c) {…} else {}` compile identically.
- `else if` chains are nested ifs whose then-branches all jump to the same end. AI scripts are one long chain on
  `AIFunction_GetCurrentEventType() == AIEVENT_*`.
- No backward branch exists in any retail file: no loops. No branch occurs inside an argument (no `?:`).
- Variables are symbols such as `EditVariable_173.nValue`, written with `ASSIGN` (`x = 2;`). AI scripts also use
  `AIFunction_SetScript{Integer,Real}Value(slot, v)` as scratch storage.
- Five level-4 AI scripts (`ai/540`–`544`) are just `0;` (`PUSH0 POP BRK`), presumably compiled from an empty script.

`npm run qvm -- <file>` prints a script as QSC-like source, `--asm` the raw instructions.

Open questions:
- Ints and floats are both plain numbers in the decoded AST, so the printer cannot show `1` vs `1.0`.
- What `PUSHA`, `BLK` and `ILLEGAL` were for; none is emitted.

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
