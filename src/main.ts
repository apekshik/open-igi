// Milestone 0: browse every texture archive in the player's install, to validate the ILFF and .tex readers.
import { readRes } from "./formats/ilff.ts";
import { decodeTex } from "./formats/tex.ts";
import { vfsFromDevServer, vfsFromFiles, type Vfs } from "./vfs/vfs.ts";

const pick = document.querySelector<HTMLInputElement>("#pick")!;
const select = document.querySelector<HTMLSelectElement>("#archive")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const grid = document.querySelector<HTMLDivElement>("#grid")!;

let vfs: Vfs | null = null;

async function useVfs(v: Vfs) {
  vfs = v;
  const archives = v.list().filter((p) => p.endsWith(".res") && p.includes("textures"));
  select.replaceChildren(...archives.sort().map((p) => new Option(p, p)));
  status.textContent = `${v.list().length} files, ${archives.length} texture archives`;
  if (archives.length) await show(archives[0]);
}

async function show(path: string) {
  if (!vfs) return;
  grid.replaceChildren();
  const entries = readRes(await vfs.read(path));
  let failed = 0;
  for (const e of entries) {
    try {
      const tex = decodeTex(e.data);
      const canvas = document.createElement("canvas");
      canvas.width = tex.width;
      canvas.height = tex.height;
      const img = new ImageData(new Uint8ClampedArray(tex.rgba), tex.width, tex.height);
      canvas.getContext("2d")!.putImageData(img, 0, 0);
      const fig = document.createElement("figure");
      const cap = document.createElement("figcaption");
      cap.textContent = `${e.name.split("/").pop()} ${tex.width}×${tex.height} f${tex.format}`;
      fig.append(canvas, cap);
      grid.append(fig);
    } catch (err) {
      failed++;
      console.warn(e.name, err);
    }
  }
  status.textContent = `${path}: ${entries.length - failed}/${entries.length} decoded`;
}

pick.addEventListener("change", () => pick.files && useVfs(vfsFromFiles(pick.files)));
select.addEventListener("change", () => show(select.value));

vfsFromDevServer().then((v) => v && useVfs(v));
