// Entry point. Without game data the page is the landing/import screen; with data (stored in this browser, or the
// dev server's IGI_DATA mount) it runs the game at ?view=play. ?view=level|models|textures|sounds are research
// viewers, ?view=landing forces the import screen.
import { landing } from "./app/landing.ts";
import { openStoredVfs } from "./vfs/import.ts";
import { vfsFromDevServer, type Vfs } from "./vfs/vfs.ts";
import { levelViewer } from "./viewer/level.ts";
import { modelViewer } from "./viewer/models.ts";
import { playView } from "./viewer/play.ts";
import { soundViewer } from "./viewer/sounds.ts";
import { textureViewer } from "./viewer/textures.ts";

const bar = document.querySelector<HTMLElement>("#bar")!;
const toolbar = document.querySelector<HTMLDivElement>("#tools")!;
const stage = document.querySelector<HTMLDivElement>("#stage")!;
const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const viewSelect = document.querySelector<HTMLSelectElement>("#view")!;

let current: Vfs | null = null;
const status = (s: string) => (statusEl.textContent = s);

function start(vfs: Vfs, view: string) {
  current = vfs;
  toolbar.replaceChildren();
  stage.replaceChildren();
  status("");
  document.body.classList.toggle("play", view === "play");
  bar.hidden = view === "play";
  viewSelect.value = view;
  if (view === "play") playView(vfs, toolbar, stage, status);
  else if (view === "textures") textureViewer(vfs, toolbar, stage, status);
  else if (view === "sounds") soundViewer(vfs, toolbar, stage, status);
  else if (view === "level") levelViewer(vfs, toolbar, stage, status);
  else modelViewer(vfs, toolbar, stage, status);
}

function enter(vfs: Vfs, view: string) {
  history.replaceState(null, "", `?view=${view}`);
  stage.classList.remove("landing-host");
  start(vfs, view);
}

async function boot() {
  const requested = new URLSearchParams(location.search).get("view");
  const vfs = (requested === "landing" ? null : await vfsFromDevServer()) ?? (await openStoredVfs().catch(() => null));
  viewSelect.addEventListener("change", () => current && enter(current, viewSelect.value));
  // The game is the default once data is available; the landing screen is the default until then.
  if (vfs && requested !== "landing") return start(vfs, requested ?? "play");
  document.body.classList.remove("play");
  bar.hidden = true;
  landing(stage, {
    existing: vfs,
    onReady: (v) => enter(v, requested && requested !== "landing" ? requested : "play"),
  });
}

boot();
