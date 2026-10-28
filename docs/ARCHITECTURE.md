# Game architecture

`?view=play&level=level1` runs the game. Everything else (`?view=level|models|textures|sounds`) is a research viewer.

## Layers

| folder | what | depends on |
|---|---|---|
| `src/formats/` | pure parsers for IGI file formats (Node + browser, no three.js) | nothing |
| `src/level/` | level assembly: objects.qvm task tree → placements, terrain builder, `loadLevel()` | formats |
| `src/render/` | three.js helpers: model library (textured, skinned models), terrain renderer | formats, level |
| `src/game/` | the runtime: `Game`, systems, services, entities, input, events | everything above |
| `src/ui/` | front end: menus, mission select, briefing, HUD, map computer (owned by the UI workstream) | game |
| `src/vfs/` | access to the player's game files (folder picker, cached import, dev mount) | nothing |

## Runtime

`Game.start({ vfs, host, level, systems })` loads the level (models, terrain, objects.qvm), places static models
in `game.world`, calls every system's `init` in order, then runs the frame loop: `update(dt)` for each system (skipped
while `game.paused`), `lateUpdate(dt)` (always), terrain LOD update, render, input end-of-frame.

Systems live in `src/game/<name>/index.ts` and are listed once in `src/game/systems.ts` (order: world, physics,
audio, player, weapons, ai, mission, hud). Each starts as a working stub; a workstream replaces its own system's
implementation in place. Do not edit `systems.ts`, `game.ts`, `entity.ts`, `input.ts`, `coords.ts` or `events.ts`
unless the change is small, generic and called out in your PR; prefer additions in your own folder.

### Talking between systems

- **Services** (`src/game/services.ts`): each system publishes one service on `game.services.<name>` in `init`,
  typed by its own `src/game/<name>/api.ts`. Other systems use only that interface and must cope with it being absent
  or a stub. You own and may extend your system's `api.ts`.
- **Events** (`src/game/events.ts`): `game.events.emit("damage", {...})` / `on(...)`. Add your own event types by
  module augmentation from your folder instead of editing events.ts:
  ```ts
  declare module "../events.ts" { interface GameEvents { "door:open": { id: number } } }
  ```
- **Entities** (`game.entities`): the player, soldiers, pickups, doors. Physics hit tests, AI targeting and the map
  use them. An entity's `taskId` is its objects.qvm task id, which mission scripts refer to.

### Coordinates

Game logic uses IGI world units: X east, Y north, Z up, 4096 per metre, absolute (around 1e7–1e8). `game.world`
children take `game.local(p)` (origin-relative, Z up). `game.toScene/fromScene` convert to and from three.js space;
`game.setView(eye, yaw, pitch, fov)` points the camera. Yaw is about Z, 0 faces +Y, positive is counter-clockwise
(`coords.direction`).

### Level data

`game.level` (`LoadedLevel`): `statements` is the full decoded objects.qvm (`Task_New(id, type, name, ...params,
...children)` trees, with each type's parameter schema in its `Task_DeclareParameters` call), `objects` the
pre-extracted placements, player start and terrain tasks, `library` builds textured (and skinned) models by name.
`src/formats/qvm.ts` decodes any script, including AI and mission control flow (`decodeQvmScript`, `formatQvm`).

## Working rules for workstreams

- Work on your own branch in your own git worktree. Keep to your folders; small shared fixes are fine if noted.
- New format notes go in `docs/formats/<topic>.md` (one file per workstream) to avoid conflicts in FORMATS.md.
- Credit any community research or code you rely on in `THIRD_PARTY.md` (append a section; don't reorder others).
- Never commit game data. Never work on copy protection.
- Test in the browser at `?view=play`; set `?level=levelN` to try other missions.
