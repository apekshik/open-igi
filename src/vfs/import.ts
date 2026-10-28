// Turn whatever the player gave us (folder, zip, iso) into a validated, persisted game-data store, and open that
// store as a Vfs on later visits.
import { openStore, type Store } from "./store.ts";
import { type SourceEntry } from "./sources.ts";
import { vfsFromStore, type Vfs } from "./vfs.ts";

export interface Detected {
  /** Prefix to strip so paths become relative to the PC folder (lowercase, empty or ending in "/"). */
  root: string;
  entries: { entry: SourceEntry; path: string }[];
  levels: number;
  /** Human-readable problems; empty when the data looks complete enough to play. */
  problems: string[];
}

const norm = (p: string) => p.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
// Code, installers and shortcuts are never needed by the engine, so we do not copy them.
const SKIP = /\.(exe|dll|url|lnk|bat|cab|hdr|inx)$/i;

/** Find the PC data root inside the source (the folder that holds missions/ and common/) and validate it. */
export function detect(source: SourceEntry[]): Detected {
  const all = source.map((entry) => ({ entry, path: norm(entry.path) }));
  const votes = new Map<string, number>();
  for (const { path } of all) {
    const m = /^(.*?)(?:missions\/location\d+\/level\d+\/objects\.qvm|common\/textures\/common\.res)$/.exec(path);
    if (m) votes.set(m[1], (votes.get(m[1]) ?? 0) + 1);
  }
  const root = [...votes].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0];
  if (root === undefined) {
    return { root: "", entries: [], levels: 0, problems: ["No Project I.G.I. data found: could not locate the missions/ and common/ folders."] };
  }
  const entries = all
    .filter(({ path }) => path.startsWith(root) && !SKIP.test(path))
    .map(({ entry, path }) => ({ entry, path: path.slice(root.length) }));
  const have = new Set(entries.map((e) => e.path));
  const problems: string[] = [];
  if (!have.has("common/textures/common.res")) problems.push("common/textures/common.res is missing.");
  const levels = new Set<string>();
  for (const p of have) {
    const m = /^missions\/(location\d+)\/(level\d+)\/objects\.qvm$/.exec(p);
    if (m) levels.add(`${m[1]}/${m[2]}`);
  }
  for (const l of levels) {
    const n = l.split("/")[1];
    const dir = `missions/${l}`;
    const need = [`${dir}/terrain/terrain.qvm`, `${dir}/models/${n}.res`, `${dir}/textures/${n}.res`];
    const missing = need.filter((f) => !have.has(f));
    if (missing.length && (n === "level1" || missing.length === need.length)) problems.push(`${l} is incomplete (missing ${missing.map((m) => m.split("/").pop()).join(", ")}).`);
  }
  if (!levels.size) problems.push("No missions found (no objects.qvm files).");
  return { root, entries, levels: levels.size, problems };
}

export interface Progress {
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  file: string;
}

/** Copy the detected files into persistent storage, then mark the import complete. */
export async function importGame(
  d: Detected,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<Vfs> {
  const store = openStore();
  await store.clear();
  // Ask the browser not to evict ~400 MB of game files under storage pressure (best effort).
  void navigator.storage?.persist?.().catch(() => {});
  const totalBytes = d.entries.reduce((a, e) => a + Math.max(e.entry.size, 0), 0);
  let bytes = 0;
  let last = 0;
  for (let i = 0; i < d.entries.length; i++) {
    if (signal?.aborted) {
      await store.clear();
      throw new DOMException("Import cancelled", "AbortError");
    }
    const { entry, path } = d.entries[i];
    const data = await entry.read();
    await store.put(path, data);
    bytes += data.length;
    const now = performance.now();
    if (now - last > 100 || i === d.entries.length - 1) {
      last = now;
      onProgress({ done: i + 1, total: d.entries.length, bytes, totalBytes: Math.max(totalBytes, bytes), file: path });
      await new Promise((r) => setTimeout(r)); // let the page paint
    }
  }
  const paths = d.entries.map((e) => e.path);
  await store.commit(paths);
  return vfsFromStore(store, paths);
}

/** The previously imported game, if any. */
export async function openStoredVfs(): Promise<Vfs | null> {
  let store: Store;
  try {
    store = openStore();
  } catch {
    return null;
  }
  const paths = await store.manifest();
  return paths?.length ? vfsFromStore(store, paths) : null;
}

export async function forgetGame() {
  await openStore().clear();
}

export const storageKind = () => openStore().kind;
