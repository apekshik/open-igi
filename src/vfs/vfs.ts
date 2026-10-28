// Read-only view of the player's IGI install, addressed by paths relative to the PC folder
// (e.g. "missions/location0/level1/textures/level1.res"). Lookups are case-insensitive.

export interface Vfs {
  read(path: string): Promise<Uint8Array>;
  has(path: string): boolean;
  list(): string[];
}

const norm = (p: string) => p.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();

/** Backed by a folder the player picked (<input webkitdirectory>). */
export function vfsFromFiles(files: FileList | File[]): Vfs {
  const map = new Map<string, File>();
  for (const f of Array.from(files)) {
    const rel = norm(f.webkitRelativePath || f.name);
    // Strip everything up to and including the folder that holds IGI.exe's siblings, so the player can pick
    // either the install folder or its parent.
    const at = rel.search(/(^|\/)(missions|common|weapons|menusystem|language|screens)\//);
    map.set(at <= 0 ? rel : rel.slice(at + 1), f);
  }
  return {
    has: (p) => map.has(norm(p)),
    list: () => [...map.keys()],
    async read(p) {
      const f = map.get(norm(p));
      if (!f) throw new Error(`not found: ${p}`);
      return new Uint8Array(await f.arrayBuffer());
    },
  };
}

/**
 * Files served over HTTP as `<base>index.json` (the lowercased paths) and `<base>file/<path>`: the Vite middleware
 * from $IGI_DATA in dev (see vite.config.ts), or a private build that ships its owner's copy (scripts/private.mjs).
 */
export async function vfsFromDevServer(base = "/__igi/"): Promise<Vfs | null> {
  const res = await fetch(`${base}index.json`).catch(() => null);
  if (!res?.ok) return null;
  const paths: string[] = await res.json();
  const set = new Set(paths.map(norm));
  return {
    has: (p) => set.has(norm(p)),
    list: () => [...set],
    async read(p) {
      const r = await fetch(`${base}file/${norm(p)}`);
      if (!r.ok) throw new Error(`not found: ${p}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

/** Backed by the persistent store written by import.ts: each file is read from storage on demand. */
export function vfsFromStore(store: { get(path: string): Promise<Uint8Array> }, paths: string[]): Vfs {
  const set = new Set(paths.map(norm));
  return {
    has: (p) => set.has(norm(p)),
    list: () => [...set],
    read: (p) => store.get(norm(p)),
  };
}
