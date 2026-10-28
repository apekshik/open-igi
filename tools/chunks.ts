// Print the chunk structure of an ILFF file. For IRES archives, list each entry with its own magic.
// Usage: npm run chunks -- <file> [--all]
import { readFileSync } from "node:fs";
import { parseIlff, readRes, readTag, isIlff } from "../src/formats/ilff.ts";

const path = process.argv[2];
const all = process.argv.includes("--all");
if (!path) {
  console.error("usage: chunks <file> [--all]");
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(path));
const file = parseIlff(bytes);
console.log(`form ${file.formType}, ${file.chunks.length} chunks, ${bytes.length} bytes`);

if (file.formType === "IRES") {
  const entries = readRes(bytes);
  const byMagic = new Map<string, number>();
  entries.forEach((e, i) => {
    const magic = e.data.length >= 4 ? readTag(e.data, 0) : "????";
    const inner = isIlff(e.data) ? `/${readTag(e.data, 16)}` : "";
    byMagic.set(magic + inner, (byMagic.get(magic + inner) ?? 0) + 1);
    if (all || i < 25) console.log(`  ${String(e.data.length).padStart(9)}  ${magic}${inner.padEnd(5)}  ${e.name}`);
  });
  if (!all && entries.length > 25) console.log(`  ... ${entries.length - 25} more (--all to list)`);
  console.log("magics:", Object.fromEntries(byMagic));
} else {
  for (const c of file.chunks) console.log(`  ${c.tag}  @${c.offset}  ${c.length} bytes`);
}
