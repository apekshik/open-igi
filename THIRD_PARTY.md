# Third-party research and code

open-igi builds on community reverse-engineering of Project I.G.I. Thank you to these projects.

## hjcminus/Project-IGI-Terrain

<https://github.com/hjcminus/Project-IGI-Terrain>, MIT License, Copyright (c) 2026 hjcminus.

An OpenGL reimplementation of IGI's terrain system, based on analysis of the decompiled `IGI.exe`. open-igi's terrain
code (`src/formats/terrain.ts`, `src/level/terrain.ts`, `src/render/terrain.ts`) follows its file layouts, octree
conventions, child transform tables, vertex unpacking, height-patch interpolation, level-of-detail and geomorph rules,
material/tile-map texturing, texture-modifier masks and lightmap passes.

```
MIT License

Copyright (c) 2026 hjcminus

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## flawme/igi-reverse-engineering

<https://github.com/flawme/igi-reverse-engineering>, MIT License.

Format documentation for IGI's terrain files (`.ctr`, `.cmd`, `.hmp`, `.bit`, `.lmp`, terrain `.tex`) and the world
scale (4096 units per metre), used as a cross-check for `docs/FORMATS.md`.

Its QVM research (`reverse/docs/03-scripting`, `reverse/tools/qvm.py`, `reverse/tools/qvmdec.py`), drawn from
`IGI.exe`, gives the opcode names and numbering, operand widths and interpreter semantics that `src/formats/qvm.ts`
uses to decode compiled scripts.

Its `.iff` animation notes (`reverse/docs/16-verified-formats`: the chunk table, `BOSH` = hierarchy + bone count,
`PLST` parents, `TLST` rest translations, `BALH[0]` = animation count, and loader evidence that playback slerps
quaternion keys) are the basis of `src/formats/anim.ts`.

The same project's audio notes (`reverse/docs/09-audio`, `reverse/tools/misc.py`) document the ILSF sound container and
its IMA ADPCM codec, which `src/formats/ilsf.ts` implements.

## heaven-hm/project-igi-converter

<https://github.com/heaven-hm/project-igi-converter>, Heaven-HM Community Modding License (noncommercial,
source-available).

Read for research only; no code from it is used. Its notes on type 1 models (`docs/mef_model_types.md`: the skin
fields and that `XTRV` holds render plus skinning-only vertices) pointed us at the extra influence records, and its bone
names for the 33-bone rigs agree with the bone order documented in `docs/FORMATS.md`.

## fflate

[fflate](https://github.com/101arrowz/fflate) (MIT) inflates entries when importing a game zip.

## flawme/igi-reverse-engineering: player rules

The same project's notes on the damage handler and hit zones (`reverse/docs/06-weapons`: player max damage from
`DefineHumanPlayerGeneral` argument 7, the 17-zone multiplier table, the player-only difficulty factor) and on world
scale and gravity (`reverse/docs/13-implementation`) underlie the player controller in `src/game/player/`.

## Haseebraza12/reimagine-igi

<https://github.com/Haseebraza12/reimagine-igi>, no license stated.

Read for research only; no code from it is used. Its exe analysis (`docs/gameplay.md`) gave the meaning of the
`DefineHumanPlayerGeneral` arguments, the movement state/clip table, root-motion speeds, jump and fall-damage rules,
lean timing, footstep-noise ranges and eye offsets that `src/game/player/` reimplements in our own terms. See
`docs/formats/player.md`.

### Fonts and menus (flawme/igi-reverse-engineering)

The same project's menu notes (`reverse/docs/10-menus`: the `FONT` chunk order, `TRAN` as a Latin-1 → glyph table,
the 40-byte `ANMF` glyph record with its UV, width, height and advance offsets, and `FNTH` fields) are the basis of
`src/formats/font.ts`; see `docs/formats/ui.md`.

## Physics and collision (hjcminus/Project-IGI-Terrain, flawme/igi-reverse-engineering)

`src/game/physics/terrain.ts` ports the terrain height query of hjcminus/Project-IGI-Terrain (MIT, above):
`Terrain::GetZ`/`RecursiveGetZ` in `source/level/terrain.cpp`, i.e. walking to the leaf cube under a point, visiting
each x/y quadrant's upper cube before its lower one, and taking the plane of the first upward triangle that contains
the point. flawme/igi-reverse-engineering's `.mef` notes (`reverse/docs/16-verified-formats`, `reverse/tools/mef_deep.py`)
gave the collision chunk sizes, the `CMSH` descriptor layout (counts on disk, pointers at run time), the `CFCE`
record and the `MESH` collision totals at `+0x6C`/`+0x70`, which `src/formats/collision.ts` builds on (see
`docs/formats/collision.md`).

## Weapons (flawme/igi-reverse-engineering)

flawme/igi-reverse-engineering's weapon notes (`reverse/docs/06-weapons`, `reverse/data/weapon_parameters.tsv`,
`reverse/data/weapon_table.tsv`, MIT) give the names and positional binding of `DefineWeaponType`'s arguments and,
from `IGI.exe`, the damage rule (hit-zone multiplier x Damage Factor, AI dying at 1.0), the AI hit-zone multipliers
(head 100) and the player's threshold and zone table in `DefineHumanPlayerGeneral`, which `src/formats/weapon.ts` and
`src/game/weapons/` use. The view-model rig, ATTA records, animation tick rate, sprite layout, spread units and
everything else in `docs/formats/weapons.md` are our own reading.

## flawme/igi-reverse-engineering: mission logic

The same project's task-system and level-system notes (`reverse/docs/11-task-system`, `reverse/docs/12-level-system`:
the `language/*.res` files and `LevelFlow_GetBreakCutSceneKey` among the script natives) guided the mission system in
`src/game/mission/`. The value of `GAME_FREQUENCY` (30) was read from IGI.exe's script constant table by us; the
remaining task semantics come from reading the levels' own objects.qvm scripts. See `docs/formats/mission.md`.

## flawme/igi-reverse-engineering: AI

The same project's AI notes (`reverse/docs/05-ai-system`: the `AIEVENT_`/`AIAction_`/`AIFunction_` names read from
`IGI.exe`) and graph notes (`reverse/docs/16-verified-formats`: the `.dat` magic, the routing table's layout and
meaning, the field-name hash and the 11 registered field names, and the existence of level 8's second layout) are the
basis of `src/formats/graph.ts` and the script runner in `src/game/ai/`. The token grammar, level 8's layout, the
patrol command ids, the soldier clip ids and the behaviour model are our own reading of the game files; see
`docs/formats/ai.md`.

## World rendering: sky, fog and level of detail

The sky and fog in `src/render/sky.ts` and `src/game/world/environment.ts` follow hjcminus/Project-IGI-Terrain (MIT,
licence above): the sky dome's shape and colour interpolation (`source/renderer/renderer_skydome.cpp`), the flat cloud
layers' plane, UV mapping and distance fade (`source/level/flat_sky_layer.cpp`), which `FlatSky`, `FlatSkyLayer` and
`GlobalLightKeyframe` parameters feed them (`source/level/level.cpp`), and its mapping of fog density to fog distance.

flawme/igi-reverse-engineering (MIT) identified `pc/lod.qvm` as the per-model LOD table (`reverse/docs/14-lod-system`),
which `src/game/world/statics.ts` reads. The `.olm` lightmap layout, the lightmap-to-model order, `LTMP` and `ATTA` are
our own reading of the data (`docs/formats/world.md`).
