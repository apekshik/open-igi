// Summarise a game install: per extension, file count, total size, and the leading "magic" tags seen.
// Usage: npm run inventory -- <dir>
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, extname, relative } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: inventory <dir>");
  process.exit(1);
}

type Bucket = { count: number; bytes: number; magics: Map<string, number>; sample: string };
const buckets = new Map<string, Bucket>();

function magicOf(path: string, size: number): string {
  if (size === 0) return "(empty)";
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(Math.min(12, size));
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  const tag = buf.subarray(0, 4);
  const printable = [...tag].every((b) => b >= 0x20 && b < 0x7f);
  // ILFF-style containers carry a second tag at offset 8; show it so "ILFF" files can be told apart.
  if (printable && buf.length >= 12) {
    const inner = buf.subarray(8, 12);
    if ([...inner].every((b) => b >= 0x20 && b < 0x7f)) return `${tag.toString("latin1")}/${inner.toString("latin1")}`;
  }
  return printable ? tag.toString("latin1") : `0x${tag.toString("hex")}`;
}

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    const ext = extname(name).toLowerCase() || "(none)";
    let b = buckets.get(ext);
    if (!b) {
      b = { count: 0, bytes: 0, magics: new Map(), sample: relative(root, p) };
      buckets.set(ext, b);
    }
    b.count++;
    b.bytes += st.size;
    const m = magicOf(p, st.size);
    b.magics.set(m, (b.magics.get(m) ?? 0) + 1);
  }
}

walk(root);

console.log("| ext | files | MB | magic tags (count) | sample |");
console.log("|---|---:|---:|---|---|");
for (const [ext, b] of [...buckets].sort((a, z) => z[1].bytes - a[1].bytes)) {
  const magics = [...b.magics]
    .sort((a, z) => z[1] - a[1])
    .slice(0, 4)
    .map(([m, n]) => `\`${m}\` (${n})`)
    .join(", ");
  console.log(`| ${ext} | ${b.count} | ${(b.bytes / 1048576).toFixed(1)} | ${magics} | ${b.sample.replaceAll("\\", "/")} |`);
}
