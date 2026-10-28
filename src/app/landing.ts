// The first screen: what open-igi is, that you bring your own copy of the game, and the import flow
// (folder, .zip or .iso -> validated -> persisted in the browser).
import { detect, forgetGame, importGame, storageKind, type Detected } from "../vfs/import.ts";
import { dropSource, folderSource, handleSource, isoSource, zipSource, type SourceEntry } from "../vfs/sources.ts";
import type { Vfs } from "../vfs/vfs.ts";

export interface LandingOptions {
  /** Game data already stored in this browser, if any. */
  existing: Vfs | null;
  /** Called with the game files once imported (or when the player presses Play). */
  onReady(vfs: Vfs): void;
  onForget?(): void;
}

const MB = 1024 * 1024;
const fmt = (b: number) => (b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(2)} GB` : `${(b / MB).toFixed(0)} MB`);

export function landing(host: HTMLElement, opts: LandingOptions) {
  host.replaceChildren();
  host.classList.add("landing-host");
  const el = document.createElement("main");
  el.className = "landing";
  const query = location.search.replace(/^\?/, "");
  const devLinks = ["level", "models", "textures", "sounds"]
    .map((v) => `<a href="?view=${v}">${v}</a>`)
    .join(" · ");
  el.innerHTML = `
    <h1>open-igi</h1>
    <p class="tag">Project I.G.I.: I'm Going In (2000), rebuilt for the browser.</p>
    <p>open-igi is a free, open-source engine that runs the original game's levels with three.js. It contains
    <strong>no game data</strong>: you need your own copy of Project I.G.I. (a PC install folder, a zip of it, or a disc
    image). Your files are read and stored only in this browser and are never uploaded anywhere.</p>
    <section id="have" hidden>
      <p>Game data found in this browser (<span id="have-kind"></span> storage).</p>
      <button id="play" class="primary">Play</button>
      <button id="forget">Forget game data</button>
    </section>
    <section id="import">
      <div id="drop" tabindex="0">
        <p><strong>Drop your game here</strong></p>
        <p class="dim">the install folder (the one containing <code>missions</code> and <code>common</code>, usually
        <code>PC</code>), a <code>.zip</code> of it, or a game <code>.iso</code></p>
        <p>
          <button id="pick-folder" class="primary">Choose folder</button>
          <button id="pick-file">Choose .zip / .iso</button>
        </p>
      </div>
      <input id="in-folder" type="file" webkitdirectory multiple hidden />
      <input id="in-file" type="file" accept=".zip,.iso" hidden />
    </section>
    <section id="progress" hidden>
      <div class="bar"><div id="fill"></div></div>
      <p id="msg" class="dim"></p>
      <button id="cancel">Cancel</button>
    </section>
    <p id="error" role="alert"></p>
    <footer>
      <p class="dim">open-igi is a free, non-commercial fan project, not affiliated with or endorsed by the owners of
      Project I.G.I. Names and trademarks belong to their owners. Source:
      <a href="https://github.com/apekshik/open-igi">github.com/apekshik/open-igi</a> (GPL-3.0).</p>
      <p class="dim">Research viewers: ${devLinks}</p>
    </footer>`;
  host.append(el);
  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const error = $("#error");
  const progress = $("#progress");
  const fill = $("#fill");
  const msg = $("#msg");
  const importSec = $("#import");
  let abort: AbortController | null = null;

  if (opts.existing) {
    $("#have").hidden = false;
    $("#have-kind").textContent = storageKind() === "opfs" ? "origin-private" : "IndexedDB";
    $("#play").onclick = () => opts.onReady(opts.existing!);
    $("#forget").onclick = async () => {
      if (!confirm("Remove the stored game files from this browser? You can import them again later.")) return;
      await forgetGame();
      opts.onForget?.();
      landing(host, { ...opts, existing: null });
    };
    importSec.querySelector("p")!.textContent = "Or import a different copy:";
  }

  const fail = (m: string) => {
    error.textContent = m;
    progress.hidden = true;
    importSec.hidden = false;
  };

  async function run(load: () => Promise<SourceEntry[]>) {
    error.textContent = "";
    importSec.hidden = true;
    progress.hidden = false;
    fill.style.width = "0%";
    msg.textContent = "Reading file list...";
    abort = new AbortController();
    try {
      const entries = await load();
      let d: Detected = detect(entries);
      if (!d.entries.length || d.problems.length) {
        return fail(
          `${d.problems.join(" ")} Pick the folder that contains missions/ and common/ (usually "PC"), or a zip/ISO of the full game.`,
        );
      }
      msg.textContent = `Found ${d.levels} missions, ${d.entries.length} files. Importing...`;
      const vfs = await importGame(
        d,
        (p) => {
          fill.style.width = `${((p.bytes / p.totalBytes) * 100).toFixed(1)}%`;
          msg.textContent = `${fmt(p.bytes)} of ${fmt(p.totalBytes)} (${p.done}/${p.total} files)`;
        },
        abort.signal,
      );
      opts.onReady(vfs);
    } catch (e) {
      if ((e as Error).name === "AbortError") return fail("Import cancelled.");
      fail(`Import failed: ${(e as Error).message}`);
    }
  }

  $("#cancel").onclick = () => abort?.abort();
  const fromFile = (f: File) => run(() => (/\.iso$/i.test(f.name) ? isoSource(f) : zipSource(f)));

  $("#pick-folder").onclick = async () => {
    const w = window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> };
    if (w.showDirectoryPicker) {
      try {
        const dir = await w.showDirectoryPicker({ id: "igi" });
        return run(() => handleSource(dir));
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        // fall through to the classic input
      }
    }
    $<HTMLInputElement>("#in-folder").click();
  };
  $("#pick-file").onclick = () => $<HTMLInputElement>("#in-file").click();
  $<HTMLInputElement>("#in-folder").onchange = (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) run(async () => folderSource(files));
  };
  $<HTMLInputElement>("#in-file").onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) fromFile(f);
  };

  const drop = $("#drop");
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const items = Array.from(e.dataTransfer?.items ?? []);
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (entries.length === 1 && entries[0].isFile) {
      const f = e.dataTransfer!.files[0];
      return fromFile(f);
    }
    if (entries.length) return run(() => dropSource(entries));
    const f = e.dataTransfer?.files[0];
    if (f) fromFile(f);
  };
}
