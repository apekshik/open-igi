// Research viewers over the player's install: ?view=models (default) or ?view=textures.
import { vfsFromDevServer, vfsFromFiles, type Vfs } from "./vfs/vfs.ts";
import { modelViewer } from "./viewer/models.ts";
import { textureViewer } from "./viewer/textures.ts";

const pick = document.querySelector<HTMLInputElement>("#pick")!;
const toolbar = document.querySelector<HTMLDivElement>("#tools")!;
const stage = document.querySelector<HTMLDivElement>("#stage")!;
const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const viewSelect = document.querySelector<HTMLSelectElement>("#view")!;

const status = (s: string) => (statusEl.textContent = s);
let vfs: Vfs | null = null;

function start() {
  if (!vfs) return;
  toolbar.replaceChildren();
  stage.replaceChildren();
  const view = viewSelect.value;
  if (view === "textures") textureViewer(vfs, toolbar, stage, status);
  else modelViewer(vfs, toolbar, stage, status);
}

viewSelect.value = new URLSearchParams(location.search).get("view") ?? "models";
viewSelect.addEventListener("change", () => {
  history.replaceState(null, "", `?view=${viewSelect.value}`);
  start();
});
pick.addEventListener("change", () => {
  if (!pick.files) return;
  vfs = vfsFromFiles(pick.files);
  start();
});

vfsFromDevServer().then((v) => {
  if (!v) return status("Pick your IGI install folder (the one with IGI.exe).");
  vfs = v;
  start();
});
