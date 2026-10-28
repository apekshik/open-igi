# open-igi

A from-scratch web engine for *Project I.G.I.: I'm Going In* (2000), in the spirit of OpenRW and OpenMW.
It runs in the browser on three.js and loads the game data from **your own copy** of the game.

This repo contains no game data and no code taken from the original executable. See [docs/CLEAN_ROOM.md](docs/CLEAN_ROOM.md).

## Status

Pre-alpha: data-format research. Milestone 1 is walking around Mission 1 with its real terrain, buildings and textures.

## Layout

- `src/formats/`: parsers for IGI's file formats (pure TypeScript, run in both Node and the browser)
- `src/vfs/`: virtual file system over the player's game files
- `tools/`: Node CLIs for format research (`npm run inventory -- <dir>`, `npm run chunks -- <file>`)
- `docs/FORMATS.md`: what we know about each format, and how confident we are

## Running

```bash
npm install
npm run dev
```

Point the page at your IGI install folder when it asks. Nothing is uploaded; files stay in your browser.

## Research tools

```bash
npm run inventory -- "C:/path/to/igi" > out/inventory.md
npm run chunks -- "C:/path/to/igi/missions/location0/level1/terrain/terrain.res"
```

Both write to stdout only. `out/` is gitignored because dumps can quote game data.
