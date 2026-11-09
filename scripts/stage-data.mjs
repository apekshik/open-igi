// Lays out a game install as the engine reads it over HTTP (see vfsFromDevServer in src/vfs/vfs.ts):
//   <dest>/index.json        every file's lowercased path
//   <dest>/file/<path>       the file itself
// Executables, DLLs and shortcuts are left out, like the importer does (SKIP in src/vfs/import.ts).
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SKIP = /\.(exe|dll|url|lnk|bat|cab|hdr|inx)$/i;

/** Copies `data` (the install's PC folder) into `dest`; returns the staged paths. */
export function stageGameData(data, dest) {
  const root = resolve(data);
  const index = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (!SKIP.test(n)) {
        const key = relative(root, p).split(sep).join("/").toLowerCase();
        const to = join(dest, "file", key);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(p, to);
        index.push(key);
      }
    }
  };
  walk(root);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "index.json"), JSON.stringify(index));
  return index;
}
