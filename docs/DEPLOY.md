# Deploying and importing game data

open-igi is a static site. It ships no game data; each player imports their own copy once, and the files are kept in
their browser.

## Hosted build

`.github/workflows/pages.yml` builds with `npm run build` and publishes `dist/` to GitHub Pages on every push to
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
