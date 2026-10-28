# Third-party research and code

open-igi builds on community reverse-engineering of Project I.G.I. Thank you to these projects.

## hjcminus/Project-IGI-Terrain

<https://github.com/hjcminus/Project-IGI-Terrain>, MIT License, Copyright (c) 2026 hjcminus.

An OpenGL reimplementation of IGI's terrain system, based on analysis of the decompiled `IGI.exe`. open-igi's terrain
code (`src/formats/terrain.ts`, `src/level/terrain.ts`) follows its file layouts, octree conventions, child transform
tables, vertex unpacking and height-patch interpolation.

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
