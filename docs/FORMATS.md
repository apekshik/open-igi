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
| .lmp / .cmd / .ctr / .hmp / .bit | 14 / 14 / 14 / 6 / 14 | ~21 | none | unknown (terrain set, one per level) | |
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

