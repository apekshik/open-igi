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
