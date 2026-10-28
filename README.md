# open-igi

A from-scratch web engine for *Project I.G.I.: I'm Going In* (2000), in the spirit of OpenRW and OpenMW.
It runs in the browser on three.js and loads the game data from **your own copy** of the game.

This repo contains no game data. It builds on community reverse-engineering of the original game, credited in
[THIRD_PARTY.md](THIRD_PARTY.md). See [docs/RULES.md](docs/RULES.md) for the project rules.
You need your own copy of the game to play.

open-igi is a free, non-commercial fan project. It is not affiliated with or endorsed by the owners of Project I.G.I.
"Project I.G.I." and related names are trademarks of their respective owners.

## Status

Alpha. All 14 missions load with IGI's own menus, HUD, map computer, weapons, guards, alarms, objectives, sound and
music. Mission 1 is playable; later missions load and run but have rougher edges (see Known issues).

## How to play

1. Open **https://apekshik.github.io/open-igi/** in a desktop browser (Chrome, Edge or Firefox).
2. **Import your copy of the game** once: drop or choose the install folder (the one with `missions` and `common`,
   usually `PC`), a `.zip` of it, or the game's `.iso`. The files are checked and kept in your browser (about 400 MB,
   never uploaded). A 180 MB zip imports in about 10 seconds. Later visits go straight to the main menu.
3. **Play Project IGI**, pick a mission, and click when the loading bar is full. Missions unlock in order, as in the
   original; add `?missions=all` to the address to pick any.

### Controls

| Action | Default |
|---|---|
| Move | W A S D (or the arrow keys) |
| Walk / jump / crouch / prone | Left Shift / Space / C or Left Ctrl / Z |
| Peek left / right | Q / E |
| Fire | Left mouse button |
| Alternate fire | Right mouse button: Dragunov scope, MP5SD zoom, M16 grenade launcher (M203) |
| Reload / use | R / F |
| Weapons | 1-9 by slot (press again to cycle), mouse wheel or [ ] for next / previous |
| Binoculars | B (wheel or mouse buttons zoom) |
| Map computer | M or Tab |
| Pause menu | Esc or P |
| Performance overlay | F3 |

Rebind keys, invert the mouse and set its sensitivity under Configuration > Controls (also in the pause menu).
Settings and mission progress are kept in your browser.

**The mouse:** the game captures the mouse when you click into it. Esc gives it back and opens the pause menu. If the
browser does not capture it again straight away (browsers wait about a second after Esc), click the game view.
Switching to another window or tab pauses the game.

### Known issues

- Missions 2-14 are less tested than Mission 1: some scripted events, cutscenes and AI behaviours are missing or wrong.
- No saving within a mission (IGI had none either).
- Performance: aims for 60 fps at 1080p on mid-range GPUs; press F3 to check. If it is slow, lower the Performance
  Level under Configuration > Graphics. High-density displays render at up to 2x resolution.
- Audio starts after your first click or key press (a browser rule).
- Mobile and touch screens are not supported.
- Clearing this site's data in the browser removes the imported game; import it again from the landing page
  (`?view=landing`).

Report bugs at https://github.com/apekshik/open-igi/issues. For performance problems, include the F3 overlay's numbers.

## Layout

- `src/formats/`: parsers for IGI's file formats (pure TypeScript, run in both Node and the browser)
- `src/level/`, `src/render/`: level assembly and three.js rendering
- `src/game/`: the runtime and its systems (player, physics, weapons, AI, missions, audio, HUD, world); see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- `src/ui/`: IGI's front end (menus, loading screen, pause and end screens)
- `src/vfs/`: access to the player's game files (import, browser storage)
- `tools/`: Node CLIs for format research
- `docs/formats/`: what we know about each format, and how confident we are

## Running from source

```bash
npm install
npm run dev     # dev server
npm test        # unit tests
npm run build   # static site in dist/ (see docs/DEPLOY.md)
```

Import your game on the page as above, or set `IGI_DATA=C:/path/to/PC` in `.env.local` to mount a folder directly.
`?view=play&level=level3` starts a mission without the menus; `?view=level|models|textures|sounds` are research viewers.

## Research tools

```bash
npm run inventory -- "C:/path/to/igi" > out/inventory.md
npm run chunks -- "C:/path/to/igi/missions/location0/level1/terrain/terrain.res"
npm run qvm -- "C:/path/to/igi/missions/location0/level1/objects.qvm"
```

All write to stdout only. `out/` is gitignored because dumps can quote game data.

## License

The open-igi source code is licensed under the [GNU GPL v3.0 or later](LICENSE). This covers only the code in this
repository. It grants no rights to Project I.G.I. or its data.
