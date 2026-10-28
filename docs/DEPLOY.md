# Deploying and importing game data

open-igi is a static site. It ships no game data; each player imports their own copy once, and the files are kept in
their browser.

## Hosted build

`.github/workflows/pages.yml` runs `npm test`, builds with `npm run build` (type check, then Vite) and publishes `dist/` to GitHub Pages on every push to
`main`. Pages is set to the "GitHub Actions" source (`gh api -X POST repos/apekshik/open-igi/pages -f build_type=workflow`).
The site lives at https://apekshik.github.io/open-igi/. `vite.config.ts` uses `base: "./"`, so the same build also
works from any other static host or sub-path.

## Data import (`src/vfs/`, `src/app/landing.ts`)

- **Sources** (`sources.ts`): a folder (File System Access `showDirectoryPicker`, `<input webkitdirectory>` or a
  dropped directory), a `.zip` (central directory read by hand, entries inflated one at a time with
  [fflate](https://github.com/101arrowz/fflate), MIT), or a `.iso` (minimal ISO 9660 + Joliet reader). All read lazily
  from `Blob.slice`, so a 180 MB archive is never in memory at once.
- **Detection and validation** (`import.ts`): the PC data root is whichever folder holds `missions/locationN/levelM/objects.qvm`
  and `common/textures/common.res`, so the "RIP" zip (`Project_IGI_RIP/PC/...`), the PC folder, or its parent all work.
  Each level needs `terrain/terrain.qvm`, `models/levelN.res` and `textures/levelN.res`; level1 must be complete.
  Executables, DLLs and shortcuts are not copied.
- **Storage** (`store.ts`): Origin Private File System where `createWritable` exists, otherwise IndexedDB. Paths are
  stored lowercased. A `manifest.json` is written last, so an interrupted import is never mistaken for a finished one.
  The browser is asked for persistent storage so the ~400 MB is not evicted under pressure.
- **Vfs** (`vfs.ts`): `vfsFromStore` reads each file from storage on demand. "Forget game data" on the landing page
  (`?view=landing`) clears it.

Importing the full RIP zip takes about 10 to 15 seconds on a desktop; the page stays responsive (one file at a time,
progress repainted every 100 ms).

## Routing

| URL | Result |
| --- | --- |
| no `view`, no data | landing/import screen |
| no `view`, data present | the game (`?view=play`) |
| `?view=play\|level\|models\|textures\|sounds` | that view (landing if no data) |
| `?view=landing` | landing screen, even with data (play / forget / re-import) |

In `npm run dev`, `IGI_DATA` (env var or `.env.local`) still mounts a local PC folder at `/__igi/` and takes priority
over stored data, except at `?view=landing`.

## Checking a production build

```bash
npm run build
npx vite preview --port 4173   # serves dist/ like a static host
```

Open it in a fresh browser profile (or after "Forget game data") and run the first-visit flow: landing page, import,
main menu, mission select, loading screen, Mission 1, pause (Esc), options, quit, reload (data and settings must still
be there), play again. The dev-only `IGI_DATA` mount does not exist in a build, so this is the path players take. F3
in game shows frame rate, frame time, draw calls, triangles and JS heap.

Reference numbers (RTX 5070 Ti desktop, Chrome, preview build, October 2026):

| | |
| --- | --- |
| Import of the RIP zip (188 MB) | about 10 s |
| Mission 1, OK to "Click to start" | about 2 s (level, systems, terrain, then shader and texture warm-up) |
| CPU per frame in the trainyard | 1-3 ms (render 1-2 ms, AI under 1 ms) |
| Draw calls / triangles | 100-450 / about 310k |
| JS heap in game | about 180 MB, flat across restarts |
