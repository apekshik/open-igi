// Ways the player can hand us their game: a folder, a .zip, or a .iso. Each becomes a list of lazily-read entries,
// so a 180 MB archive is never held in memory at once. Zip uses plain deflate (fflate); ISO 9660 is just a
// directory tree.
import { inflateSync } from "fflate";

export interface SourceEntry {
  path: string;
  /** Uncompressed size in bytes, or -1 when unknown until read. */
  size: number;
  read(): Promise<Uint8Array>;
}

const u8 = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** Entries from <input webkitdirectory> / dropped files carrying webkitRelativePath. */
export function folderSource(files: FileList | File[]): SourceEntry[] {
  return Array.from(files).map((f) => ({
    path: f.webkitRelativePath || f.name,
    size: f.size,
    read: () => u8(f),
  }));
}

/** Entries from a File System Access directory handle (showDirectoryPicker). */
export async function handleSource(dir: FileSystemDirectoryHandle): Promise<SourceEntry[]> {
  const out: SourceEntry[] = [];
  const walk = async (d: FileSystemDirectoryHandle, prefix: string) => {
    const it = (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, h] of it) {
      if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, `${prefix}${name}/`);
      else {
        const fh = h as FileSystemFileHandle;
        out.push({ path: prefix + name, size: -1, read: async () => u8(await fh.getFile()) });
      }
    }
  };
  await walk(dir, `${dir.name}/`);
  return out;
}

/** Entries from a dropped directory tree (DataTransferItem.webkitGetAsEntry). */
export async function dropSource(items: FileSystemEntry[]): Promise<SourceEntry[]> {
  const out: SourceEntry[] = [];
  const readAll = (r: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((res, rej) => {
      const acc: FileSystemEntry[] = [];
      const next = () =>
        r.readEntries((batch) => {
          if (!batch.length) return res(acc);
          acc.push(...batch);
          next();
        }, rej);
      next();
    });
  const walk = async (e: FileSystemEntry) => {
    if (e.isDirectory) for (const c of await readAll((e as FileSystemDirectoryEntry).createReader())) await walk(c);
    else {
      const fe = e as FileSystemFileEntry;
      out.push({
        path: e.fullPath,
        size: -1,
        read: async () => u8(await new Promise<File>((res, rej) => fe.file(res, rej))),
      });
    }
  };
  for (const e of items) await walk(e);
  return out;
}

/** Reads a zip through its central directory: only the entries we keep are ever sliced out and inflated. */
export async function zipSource(file: Blob): Promise<SourceEntry[]> {
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let e = tail.length - 22;
  while (e >= 0 && tv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("This does not look like a zip file.");
  let count = tv.getUint16(e + 10, true);
  let cdSize = tv.getUint32(e + 12, true);
  let cdOff = tv.getUint32(e + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) {
    // Zip64: the real values live in the zip64 end-of-central-directory record.
    if (e < 20 || tv.getUint32(e - 20, true) !== 0x07064b50) throw new Error("Unsupported zip64 layout.");
    const rec = Number(tv.getBigUint64(e - 20 + 8, true));
    const h = new DataView(await file.slice(rec, rec + 56).arrayBuffer());
    count = Number(h.getBigUint64(32, true));
    cdSize = Number(h.getBigUint64(40, true));
    cdOff = Number(h.getBigUint64(48, true));
  }
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const v = new DataView(cd.buffer);
  const dec = new TextDecoder();
  const out: SourceEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/") || flags & 1) continue; // directories; encrypted entries are unsupported
    out.push({
      path: name,
      size: usize,
      async read() {
        const lh = new DataView(await file.slice(off, off + 30).arrayBuffer());
        const start = off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = await u8(file.slice(start, start + csize));
        if (method === 0) return raw;
        if (method === 8) return inflateSync(raw, { out: new Uint8Array(usize) });
        throw new Error(`${name}: unsupported zip compression method ${method}`);
      },
    });
  }
  return out;
}

/** Minimal ISO 9660 reader (prefers the Joliet tree for long names). 2048-byte sectors. */
export async function isoSource(file: Blob): Promise<SourceEntry[]> {
  const SECTOR = 2048;
  const sector = async (lba: number, n = 1) => new Uint8Array(await file.slice(lba * SECTOR, (lba + n) * SECTOR).arrayBuffer());
  let root: { lba: number; size: number } | null = null;
  let joliet = false;
  for (let lba = 16; lba < 40; lba++) {
    const s = await sector(lba);
    if (s.length < SECTOR || s[0] === 255) break;
    if (String.fromCharCode(...s.subarray(1, 6)) !== "CD001") throw new Error("This does not look like a standard ISO image.");
    const dv = new DataView(s.buffer);
    const rec = { lba: dv.getUint32(158, true), size: dv.getUint32(166, true) };
    if (s[0] === 1 && !root) root = rec;
    if (s[0] === 2 && s[88] === 0x25 && s[89] === 0x2f && [0x40, 0x43, 0x45].includes(s[90])) {
      root = rec;
      joliet = true;
    }
  }
  if (!root) throw new Error("No ISO 9660 volume descriptor found.");
  const out: SourceEntry[] = [];
  const walk = async (lba: number, size: number, prefix: string) => {
    const data = await sector(lba, Math.ceil(size / SECTOR));
    const dv = new DataView(data.buffer);
    let p = 0;
    while (p < size) {
      const len = data[p];
      if (len === 0) {
        p = (Math.floor(p / SECTOR) + 1) * SECTOR; // records never straddle sectors
        continue;
      }
      const extent = dv.getUint32(p + 2, true);
      const dsize = dv.getUint32(p + 10, true);
      const isDir = (data[p + 25] & 2) !== 0;
      const nlen = data[p + 32];
      const raw = data.subarray(p + 33, p + 33 + nlen);
      p += len;
      if (nlen === 1 && (raw[0] === 0 || raw[0] === 1)) continue;
      let name = joliet
        ? Array.from({ length: nlen >> 1 }, (_, i) => String.fromCharCode((raw[i * 2] << 8) | raw[i * 2 + 1])).join("")
        : String.fromCharCode(...raw);
      name = name.replace(/;\d+$/, "").replace(/\.$/, "");
      if (isDir) await walk(extent, dsize, `${prefix}${name}/`);
      else out.push({ path: prefix + name, size: dsize, read: () => u8(file.slice(extent * SECTOR, extent * SECTOR + dsize)) });
    }
  };
  await walk(root.lba, root.size, "");
  return out;
}
