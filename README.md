# open-igi

A from-scratch web engine for *Project I.G.I.: I'm Going In* (2000), in the spirit of OpenRW and OpenMW.
It runs in the browser on three.js and loads the game data from **your own copy** of the game.

This repo contains no game data. It builds on community reverse-engineering of the original game, credited in
[THIRD_PARTY.md](THIRD_PARTY.md). See [docs/RULES.md](docs/RULES.md) for the project rules.
You need your own copy of the game to play.

open-igi is a free, non-commercial fan project. It is not affiliated with or endorsed by the owners of Project I.G.I.
"Project I.G.I." and related names are trademarks of their respective owners.

## Status

Pre-alpha. Every level loads in the browser: the terrain from the game's own octree files, and every building and prop from
its placement script, with real textures, and the terrain is textured and lit as in the original. Next: characters in
levels, then walking around Mission 1 on foot.

## Layout

- `src/formats/`: parsers for IGI's file formats (pure TypeScript, run in both Node and the browser)
- `src/vfs/`: virtual file system over the player's game files
- `tools/`: Node CLIs for format research (`npm run inventory -- <dir>`, `npm run chunks -- <file>`)
- `docs/FORMATS.md`: what we know about each format, and how confident we are

## Running

**In the browser:** https://apekshik.github.io/open-igi/ . open-igi hosts no game data, so on first visit it asks for
your own copy: choose or drop the install folder (the one that contains `missions` and `common`, usually `PC`), a
`.zip` of it, or a game `.iso`. The files are validated and stored in your browser (never uploaded); later visits start
straight into the game, and "Forget game data" on the landing page removes them. See [docs/DEPLOY.md](docs/DEPLOY.md).

**From source:**

```bash
npm install
npm run dev
```

Import your game on the page the same way, or set `IGI_DATA=C:/path/to/PC` in `.env.local` to mount a folder directly.

## Research tools

```bash
npm run inventory -- "C:/path/to/igi" > out/inventory.md
npm run chunks -- "C:/path/to/igi/missions/location0/level1/terrain/terrain.res"
```

Both write to stdout only. `out/` is gitignored because dumps can quote game data.

## License

The open-igi source code is licensed under the [GNU GPL v3.0 or later](LICENSE). This covers only the code in this
repository. It grants no rights to Project I.G.I. or its data.
