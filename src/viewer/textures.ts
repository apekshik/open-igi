// Texture browser: every texture archive in the install, decoded to canvases.
import { readRes } from "../formats/ilff.ts";
import { decodeTex } from "../formats/tex.ts";
import type { Vfs } from "../vfs/vfs.ts";

export function textureViewer(vfs: Vfs, toolbar: HTMLElement, stage: HTMLElement, status: (s: string) => void) {
  const select = document.createElement("select");
  toolbar.append(select);
  const grid = document.createElement("div");
  grid.className = "grid";
  stage.append(grid);

  const archives = vfs.list().filter((p) => p.endsWith(".res") && p.includes("textures")).sort();
  select.replaceChildren(...archives.map((p) => new Option(p, p)));
  select.addEventListener("change", () => show(select.value));

  async function show(path: string) {
    grid.replaceChildren();
    const entries = readRes(await vfs.read(path));
    let failed = 0;
    for (const e of entries) {
      try {
        const tex = decodeTex(e.data);
        const canvas = document.createElement("canvas");
        canvas.width = tex.width;
        canvas.height = tex.height;
        canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(tex.rgba), tex.width, tex.height), 0, 0);
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
    status(`${path}: ${entries.length - failed}/${entries.length} decoded`);
  }

  if (archives.length) show(archives[0]);
}
