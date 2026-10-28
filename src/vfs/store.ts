// Persistent storage for the player's imported game files: the Origin Private File System where it can write
// (Chromium, Firefox), IndexedDB everywhere else. Paths are stored lowercased, so lookups are case-insensitive like
// the rest of the Vfs. Nothing here ever leaves the browser.

export interface Store {
  readonly kind: "opfs" | "idb";
  /** Paths of a completed import, or null when nothing (or only a partial import) is stored. */
  manifest(): Promise<string[] | null>;
  put(path: string, data: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  /** Marks the import complete; until this runs the stored files are not offered to the game. */
  commit(paths: string[]): Promise<void>;
  clear(): Promise<void>;
}

const ROOT = "igi-data";
const MANIFEST = "manifest.json";

const canWriteOpfs = () =>
  typeof navigator !== "undefined" &&
  !!navigator.storage?.getDirectory &&
  typeof FileSystemFileHandle !== "undefined" &&
  "createWritable" in FileSystemFileHandle.prototype;

export function openStore(): Store {
  return canWriteOpfs() ? opfsStore() : idbStore();
}

function opfsStore(): Store {
  const dirs = new Map<string, FileSystemDirectoryHandle>();
  const base = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
  const dirFor = async (parts: string[], create: boolean) => {
    let cur = await base();
    for (let i = 0; i < parts.length; i++) {
      const k = parts.slice(0, i + 1).join("/");
      let next = dirs.get(k);
      if (!next) {
        next = await cur.getDirectoryHandle(parts[i], { create });
        dirs.set(k, next);
      }
      cur = next;
    }
    return cur;
  };
  const split = (path: string) => {
    const parts = path.split("/");
    return { dir: parts.slice(0, -1), name: parts[parts.length - 1] };
  };
  const write = async (h: FileSystemFileHandle, data: BufferSource | string) => {
    const w = await h.createWritable();
    await w.write(data);
    await w.close();
  };
  return {
    kind: "opfs",
    async manifest() {
      try {
        const f = await (await (await base()).getFileHandle(MANIFEST)).getFile();
        return JSON.parse(await f.text());
      } catch {
        return null;
      }
    },
    async put(path, data) {
      const { dir, name } = split(path);
      await write(await (await dirFor(dir, true)).getFileHandle(name, { create: true }), data as unknown as BufferSource);
    },
    async get(path) {
      const { dir, name } = split(path);
      const h = await (await dirFor(dir, false)).getFileHandle(name);
      return new Uint8Array(await (await h.getFile()).arrayBuffer());
    },
    async commit(paths) {
      await write(await (await base()).getFileHandle(MANIFEST, { create: true }), JSON.stringify(paths));
    },
    async clear() {
      dirs.clear();
      await (await navigator.storage.getDirectory()).removeEntry(ROOT, { recursive: true }).catch(() => {});
    },
  };
}

function idbStore(): Store {
  const OS = "files";
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((res, rej) => {
      const r = indexedDB.open("open-igi", 1);
      r.onupgradeneeded = () => r.result.createObjectStore(OS);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const s = (await open()).transaction(OS, mode).objectStore(OS);
    return new Promise<T>((res, rej) => {
      const r = fn(s);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  };
  return {
    kind: "idb",
    async manifest() {
      try {
        return ((await run("readonly", (s) => s.get("\0manifest"))) as string[] | undefined) ?? null;
      } catch {
        return null;
      }
    },
    async put(path, data) {
      await run("readwrite", (s) => s.put(new Blob([data as unknown as BlobPart]), path));
    },
    async get(path) {
      const b = (await run("readonly", (s) => s.get(path))) as Blob | undefined;
      if (!b) throw new Error(`not found: ${path}`);
      return new Uint8Array(await b.arrayBuffer());
    },
    async commit(paths) {
      await run("readwrite", (s) => s.put(paths, "\0manifest"));
    },
    async clear() {
      await run("readwrite", (s) => s.clear());
    },
  };
}
